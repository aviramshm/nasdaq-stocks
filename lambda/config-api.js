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
            enabled: env.ALERT_ENABLED === 'true',
            threshold: parseFloat(env.DROP_THRESHOLD || '5')
        })
    };
}

async function runNow() {
    const command = new InvokeCommand({
        FunctionName: ALERT_FUNCTION_NAME,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({})
    });

    const response = await lambda.send(command);
    const payload = JSON.parse(Buffer.from(response.Payload).toString());

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            message: 'Scan completed',
            result: JSON.parse(payload.body || '{}')
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
        ALERT_ENABLED: String(config.enabled !== false),
        DROP_THRESHOLD: String(config.threshold || 5)
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
            enabled: newEnv.ALERT_ENABLED === 'true',
            threshold: parseFloat(newEnv.DROP_THRESHOLD)
        })
    };
}
