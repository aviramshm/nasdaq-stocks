/**
 * Orchestrator Function
 * Triggers all enabled rule functions on daily schedule
 * Maintains backward compatibility with previous monolithic approach
 */
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambda = new LambdaClient({});

const RULE_FUNCTIONS = [
    'stock-alert-rule1',
    'stock-alert-rule2',
    'stock-alert-rule3',
    'stock-alert-rule4',
    'stock-alert-rule5',
    'stock-alert-rule6',
    'stock-alert-rule7'
    // rule8 has its own dedicated EventBridge schedule at 4:33 PM IL — not run via orchestrator
];

exports.handler = async (event) => {
    console.log('Orchestrator triggered');
    console.log('Event:', JSON.stringify(event));

    try {
        // Invoke all rule functions asynchronously (in parallel)
        const invocations = RULE_FUNCTIONS.map(functionName => {
            console.log(`Invoking ${functionName}...`);
            return lambda.send(new InvokeCommand({
                FunctionName: functionName,
                InvocationType: 'Event', // Async invocation
                Payload: JSON.stringify({ source: 'orchestrator' })
            })).catch(err => {
                console.error(`Error invoking ${functionName}:`, err);
                return { error: err.message, functionName };
            });
        });

        // Wait for all invocations to complete (but don't wait for rule execution)
        const results = await Promise.allSettled(invocations);

        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        console.log(`Orchestrator complete: ${successful} invoked, ${failed} failed`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'All rule functions triggered',
                invoked: successful,
                failed: failed,
                timestamp: new Date().toISOString()
            })
        };

    } catch (error) {
        console.error('Error in orchestrator:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
