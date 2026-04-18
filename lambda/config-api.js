/**
 * AWS Lambda Function: Stock Alert Configuration API
 *
 * Handles GET/POST requests to read and update alert configuration.
 */

const { LambdaClient, UpdateFunctionConfigurationCommand, GetFunctionConfigurationCommand, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambda = new LambdaClient({});

// Rule function names
const RULE_FUNCTIONS = {
    rule1: 'stock-alert-rule1',
    rule2: 'stock-alert-rule2',
    rule3: 'stock-alert-rule3',
    rule4: 'stock-alert-rule4',
    rule5: 'stock-alert-rule5',
    rule6: 'stock-alert-rule6',
    rule7: 'stock-alert-rule7',
    rule8: 'stock-alert-rule8'
};

const ORCHESTRATOR_FUNCTION = 'stock-alert-orchestrator';

// CORS headers
const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

exports.handler = async (event) => {
    console.log('Event:', JSON.stringify(event));

    // Handle CORS preflight
    if (event.requestContext?.http?.method === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    const method = event.requestContext?.http?.method || event.httpMethod;

    const path = event.requestContext?.http?.path || event.path || '';

    try {
        // Route: POST /config/rule/{ruleId}/run - Run individual rule
        const ruleRunMatch = path.match(/\/rule\/(\d+)\/run$/);
        if (ruleRunMatch && method === 'POST') {
            const ruleId = ruleRunMatch[1];
            return await runSingleRule(ruleId);
        }

        // Route: POST /run - Run all rules via orchestrator
        if (path.endsWith('/run') && method === 'POST') {
            return await runNow();
        }

        // Route: GET /config - Get configuration
        if (method === 'GET') {
            return await getConfig();
        }

        // Route: POST /config - Update configuration
        if (method === 'POST') {
            const body = JSON.parse(event.body || '{}');
            return await updateConfig(body);
        }

        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};

async function getConfig() {
    // Query all 6 rule functions for their current configuration
    const configPromises = Object.entries(RULE_FUNCTIONS).map(async ([ruleKey, functionName]) => {
        try {
            const command = new GetFunctionConfigurationCommand({
                FunctionName: functionName
            });
            const response = await lambda.send(command);
            return { ruleKey, env: response.Environment?.Variables || {} };
        } catch (error) {
            console.error(`Error getting config for ${functionName}:`, error);
            return { ruleKey, env: {} };
        }
    });

    const configs = await Promise.all(configPromises);

    // Merge all configs into a single response
    const mergedConfig = {};
    configs.forEach(({ ruleKey, env }) => {
        const ruleNum = ruleKey.replace('rule', '');

        if (ruleNum === '1') {
            mergedConfig.rule1Enabled = env.RULE1_ENABLED === 'true';
            mergedConfig.rule1Threshold = parseFloat(env.RULE1_THRESHOLD || '15');
        } else if (ruleNum === '2') {
            mergedConfig.rule2Enabled = env.RULE2_ENABLED === 'true';
            mergedConfig.rule2Threshold = parseFloat(env.RULE2_THRESHOLD || '20');
        } else if (ruleNum === '3') {
            mergedConfig.rule3Enabled = env.RULE3_ENABLED === 'true';
            mergedConfig.rule3Threshold1 = parseFloat(env.RULE3_THRESHOLD1 || '10');
            mergedConfig.rule3Threshold2 = parseFloat(env.RULE3_THRESHOLD2 || '3');
        } else if (ruleNum === '4') {
            mergedConfig.rule4Enabled = env.RULE4_ENABLED === 'true';
            mergedConfig.rule4Threshold = parseFloat(env.RULE4_THRESHOLD || '5');
        } else if (ruleNum === '5') {
            mergedConfig.rule5Enabled = env.RULE5_ENABLED === 'true';
            mergedConfig.rule5Threshold1 = parseFloat(env.RULE5_THRESHOLD1 || '5');
            mergedConfig.rule5Threshold2 = parseFloat(env.RULE5_THRESHOLD2 || '2');
        } else if (ruleNum === '6') {
            mergedConfig.rule6Enabled = env.RULE6_ENABLED === 'true';
            mergedConfig.rule6Threshold1 = parseFloat(env.RULE6_THRESHOLD1 || '3');
            mergedConfig.rule6Threshold2 = parseFloat(env.RULE6_THRESHOLD2 || '2');
        } else if (ruleNum === '7') {
            mergedConfig.rule7Enabled = env.RULE7_ENABLED === 'true';
            mergedConfig.rule7Days = parseInt(env.RULE7_DAYS || '3', 10);
        } else if (ruleNum === '8') {
            mergedConfig.rule8Enabled = env.RULE8_ENABLED === 'true';
            mergedConfig.rule8Days = parseInt(env.RULE8_DAYS || '5', 10);
            mergedConfig.rule8DropThreshold = parseFloat(env.RULE8_DROP_THRESHOLD || '10');
            mergedConfig.rule8GainThreshold = parseFloat(env.RULE8_GAIN_THRESHOLD || '3');
            mergedConfig.rule8VolumeThreshold = parseFloat(env.RULE8_VOLUME_THRESHOLD || '1.5');
        }
    });

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(mergedConfig)
    };
}

async function runNow() {
    // Invoke orchestrator to run all rules
    const command = new InvokeCommand({
        FunctionName: ORCHESTRATOR_FUNCTION,
        InvocationType: 'Event', // Async invocation
        Payload: JSON.stringify({ source: 'manual-run' })
    });

    await lambda.send(command);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            message: 'All rules scan started',
            note: 'Results will be sent to Slack when complete'
        })
    };
}

async function runSingleRule(ruleId) {
    const ruleKey = `rule${ruleId}`;
    const functionName = RULE_FUNCTIONS[ruleKey];

    if (!functionName) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: `Rule ${ruleId} not found` })
        };
    }

    // Invoke single rule function with forceRun flag
    const command = new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event', // Async invocation
        Payload: JSON.stringify({ forceRun: true, source: 'manual-run' })
    });

    await lambda.send(command);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            message: `Rule ${ruleId} scan started`,
            note: 'Results will be sent to Slack when complete'
        })
    };
}

async function updateConfig(config) {
    // Update environment variables for all 6 rule functions in parallel
    const updatePromises = Object.entries(RULE_FUNCTIONS).map(async ([ruleKey, functionName]) => {
        try {
            // Get current config first
            const getCommand = new GetFunctionConfigurationCommand({
                FunctionName: functionName
            });
            const current = await lambda.send(getCommand);
            const currentEnv = current.Environment?.Variables || {};

            // Build new environment variables based on rule
            let newEnv = { ...currentEnv };
            const ruleNum = ruleKey.replace('rule', '');

            if (ruleNum === '1') {
                newEnv.RULE1_ENABLED = String(config.rule1Enabled !== false);
                newEnv.RULE1_THRESHOLD = String(config.rule1Threshold || 15);
            } else if (ruleNum === '2') {
                newEnv.RULE2_ENABLED = String(config.rule2Enabled === true);
                newEnv.RULE2_THRESHOLD = String(config.rule2Threshold || 20);
            } else if (ruleNum === '3') {
                newEnv.RULE3_ENABLED = String(config.rule3Enabled === true);
                newEnv.RULE3_THRESHOLD1 = String(config.rule3Threshold1 || 10);
                newEnv.RULE3_THRESHOLD2 = String(config.rule3Threshold2 || 3);
            } else if (ruleNum === '4') {
                newEnv.RULE4_ENABLED = String(config.rule4Enabled === true);
                newEnv.RULE4_THRESHOLD = String(config.rule4Threshold || 5);
            } else if (ruleNum === '5') {
                newEnv.RULE5_ENABLED = String(config.rule5Enabled === true);
                newEnv.RULE5_THRESHOLD1 = String(config.rule5Threshold1 || 5);
                newEnv.RULE5_THRESHOLD2 = String(config.rule5Threshold2 || 2);
            } else if (ruleNum === '6') {
                newEnv.RULE6_ENABLED = String(config.rule6Enabled === true);
                newEnv.RULE6_THRESHOLD1 = String(config.rule6Threshold1 || 3);
                newEnv.RULE6_THRESHOLD2 = String(config.rule6Threshold2 || 2);
            } else if (ruleNum === '7') {
                newEnv.RULE7_ENABLED = String(config.rule7Enabled === true);
                newEnv.RULE7_DAYS = String(config.rule7Days || 3);
            } else if (ruleNum === '8') {
                newEnv.RULE8_ENABLED = String(config.rule8Enabled === true);
                newEnv.RULE8_DAYS = String(config.rule8Days || 5);
                newEnv.RULE8_DROP_THRESHOLD = String(config.rule8DropThreshold || 10);
                newEnv.RULE8_GAIN_THRESHOLD = String(config.rule8GainThreshold || 3);
                newEnv.RULE8_VOLUME_THRESHOLD = String(config.rule8VolumeThreshold || 1.5);
            }

            const updateCommand = new UpdateFunctionConfigurationCommand({
                FunctionName: functionName,
                Environment: { Variables: newEnv }
            });

            await lambda.send(updateCommand);
            return { ruleKey, success: true };
        } catch (error) {
            console.error(`Error updating config for ${functionName}:`, error);
            return { ruleKey, success: false, error: error.message };
        }
    });

    const results = await Promise.all(updatePromises);
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return {
        statusCode: failed > 0 ? 207 : 200, // 207 Multi-Status if some failed
        headers,
        body: JSON.stringify({
            message: 'Configuration update complete',
            updated: successful,
            failed: failed,
            config: config
        })
    };
}
