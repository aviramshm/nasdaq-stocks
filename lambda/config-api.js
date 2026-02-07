/**
 * AWS Lambda Function: Stock Alert Configuration API
 *
 * Handles GET/POST requests to read and update alert configuration.
 */

const { LambdaClient, UpdateFunctionConfigurationCommand, GetFunctionConfigurationCommand, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambda = new LambdaClient({});
const ALERT_FUNCTION_NAME = 'stock-drop-alert';

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
        if (path.endsWith('/run') && method === 'POST') {
            return await runNow();
        } else if (method === 'GET') {
            return await getConfig();
        } else if (method === 'POST') {
            const body = JSON.parse(event.body || '{}');
            return await updateConfig(body);
        } else {
            return {
                statusCode: 405,
                headers,
                body: JSON.stringify({ error: 'Method not allowed' })
            };
        }
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
    const command = new GetFunctionConfigurationCommand({
        FunctionName: ALERT_FUNCTION_NAME
    });

    const response = await lambda.send(command);
    const env = response.Environment?.Variables || {};

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            rule1Enabled: env.RULE1_ENABLED === 'true',
            rule1Threshold: parseFloat(env.RULE1_THRESHOLD || '15'),
            rule2Enabled: env.RULE2_ENABLED === 'true',
            rule2Threshold: parseFloat(env.RULE2_THRESHOLD || '20')
        })
    };
}

async function runNow() {
    // Invoke asynchronously to avoid API Gateway timeout
    const command = new InvokeCommand({
        FunctionName: ALERT_FUNCTION_NAME,
        InvocationType: 'Event', // Async invocation
        Payload: JSON.stringify({ forceRun: true })
    });

    await lambda.send(command);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            message: 'Scan started',
            note: 'Results will be sent to Slack when complete'
        })
    };
}

async function updateConfig(config) {
    // Get current config first
    const getCommand = new GetFunctionConfigurationCommand({
        FunctionName: ALERT_FUNCTION_NAME
    });
    const current = await lambda.send(getCommand);
    const currentEnv = current.Environment?.Variables || {};

    // Merge with new values
    const newEnv = {
        ...currentEnv,
        RULE1_ENABLED: String(config.rule1Enabled !== false),
        RULE1_THRESHOLD: String(config.rule1Threshold || 15),
        RULE2_ENABLED: String(config.rule2Enabled === true),
        RULE2_THRESHOLD: String(config.rule2Threshold || 20)
    };

    const updateCommand = new UpdateFunctionConfigurationCommand({
        FunctionName: ALERT_FUNCTION_NAME,
        Environment: { Variables: newEnv }
    });

    await lambda.send(updateCommand);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            message: 'Configuration updated',
            rule1Enabled: newEnv.RULE1_ENABLED === 'true',
            rule1Threshold: parseFloat(newEnv.RULE1_THRESHOLD),
            rule2Enabled: newEnv.RULE2_ENABLED === 'true',
            rule2Threshold: parseFloat(newEnv.RULE2_THRESHOLD)
        })
    };
}
