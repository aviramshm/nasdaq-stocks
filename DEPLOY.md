# Stock Alerts Deployment Guide

## Prerequisites

1. **AWS CLI** installed and configured
   ```bash
   aws --version
   aws configure
   ```

2. **AWS SAM CLI** installed
   ```bash
   sam --version
   # If not installed: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
   ```

3. **Slack Webhook URL**
   - Create a Slack incoming webhook: https://api.slack.com/messaging/webhooks
   - Save the webhook URL (you'll need it during deployment)

## Initial Deployment

### Step 1: Navigate to Lambda Directory
```bash
cd /Users/aviram/projects/shares/nasdaq-stocks/lambda
```

### Step 2: Install Dependencies
```bash
# Install Node.js dependencies for orchestrator and config-api
npm install
```

### Step 3: Build the Application
```bash
sam build
```

This command:
- Packages the Lambda layer with shared utilities
- Prepares all 6 rule functions
- Prepares the orchestrator function
- Prepares the config API function

### Step 4: Validate the Template
```bash
sam validate
```

Ensure there are no errors before deploying.

### Step 5: Deploy (Interactive Mode - First Time)
```bash
sam deploy --guided
```

You'll be prompted for:
- **Stack Name**: `stock-alerts-v2` (recommended) or your choice
- **AWS Region**: `us-east-1` (or your preferred region)
- **Parameter SlackWebhookUrl**: Paste your Slack webhook URL
- **Confirm changes before deploy**: Y
- **Allow SAM CLI IAM role creation**: Y
- **Save arguments to configuration file**: Y

This creates a `samconfig.toml` file with your settings.

### Step 6: Verify Deployment
```bash
# List all deployed functions
aws lambda list-functions --query 'Functions[?starts_with(FunctionName, `stock-alert`)].FunctionName'

# Expected output:
# - stock-alert-rule1
# - stock-alert-rule2
# - stock-alert-rule3
# - stock-alert-rule4
# - stock-alert-rule5
# - stock-alert-rule6
# - stock-alert-orchestrator
# - stock-alerts-config-api
```

### Step 7: Get API Gateway URL
```bash
aws cloudformation describe-stacks \
  --stack-name stock-alerts-v2 \
  --query 'Stacks[0].Outputs[?OutputKey==`ConfigApiUrl`].OutputValue' \
  --output text
```

Copy this URL and update it in `index.html` (line 409) if needed.

## Subsequent Deployments

After the initial deployment, you can deploy updates quickly:

```bash
cd /Users/aviram/projects/shares/nasdaq-stocks/lambda
sam build && sam deploy
```

This uses the settings saved in `samconfig.toml`.

## Testing After Deployment

### Test 1: Invoke Orchestrator (All Rules)
```bash
aws lambda invoke \
  --function-name stock-alert-orchestrator \
  --payload '{}' \
  response.json

cat response.json
```

Expected: `{"statusCode":200,"body":"..."}`

### Test 2: Invoke Single Rule
```bash
aws lambda invoke \
  --function-name stock-alert-rule1 \
  --payload '{"forceRun": true}' \
  response.json

cat response.json
```

Check Slack for the alert message.

### Test 3: Config API - Get Configuration
```bash
API_URL=$(aws cloudformation describe-stacks \
  --stack-name stock-alerts-v2 \
  --query 'Stacks[0].Outputs[?OutputKey==`ConfigApiUrl`].OutputValue' \
  --output text)

curl $API_URL
```

Expected: JSON with all rule configurations.

### Test 4: Config API - Test Single Rule
```bash
curl -X POST $API_URL/rule/1/run
```

Expected: `{"message":"Rule 1 scan started",...}`

### Test 5: Monitor Logs
```bash
# Watch orchestrator logs
aws logs tail /aws/lambda/stock-alert-orchestrator --follow

# Watch specific rule logs
aws logs tail /aws/lambda/stock-alert-rule1 --follow
```

## Frontend Update

After deployment, update the frontend API URL if the API Gateway endpoint changed:

1. Get the new API Gateway URL:
   ```bash
   aws cloudformation describe-stacks \
     --stack-name stock-alerts-v2 \
     --query 'Stacks[0].Outputs[?OutputKey==`ConfigApiUrl`].OutputValue' \
     --output text
   ```

2. Update `index.html` line 409:
   ```javascript
   const API_URL = 'YOUR_NEW_API_URL';
   ```

3. Commit and push to trigger AWS Amplify auto-deployment:
   ```bash
   git add index.html
   git commit -m "Update API URL for v2 architecture"
   git push origin main
   ```

## Configuration Management

### View Current Configuration
```bash
curl $API_URL
```

### Update Configuration
```bash
curl -X POST $API_URL \
  -H "Content-Type: application/json" \
  -d '{
    "rule1Enabled": true,
    "rule1Threshold": 15,
    "rule2Enabled": false,
    "rule2Threshold": 20,
    "rule3Enabled": true,
    "rule3Threshold1": 10,
    "rule3Threshold2": 3,
    "rule4Enabled": false,
    "rule4Threshold": 5,
    "rule5Enabled": false,
    "rule5Threshold1": 5,
    "rule5Threshold2": 2,
    "rule6Enabled": false,
    "rule6Threshold1": 3,
    "rule6Threshold2": 2
  }'
```

## Rollback Plan

If you need to rollback to the previous monolithic architecture:

1. The old `stock-alerts.js` file is still in the repository
2. You can redeploy the old stack or switch the EventBridge schedule back to the old function
3. Keep both stacks running during migration if needed for zero downtime

## Cost Estimation

With 6 independent rule functions + orchestrator:
- Daily executions: 1 orchestrator + 6 rules = 7 invocations/day
- Monthly: ~140 invocations (weekdays only)
- Estimated cost: **~$0.08/month** (vs $0.01 for single function)
- Still well within AWS Free Tier limits

## Troubleshooting

### Issue: Lambda Layer Not Found
```bash
# Check if layer was created
aws lambda list-layers --query 'Layers[?LayerName==`stock-utils`]'

# If missing, rebuild and redeploy
sam build && sam deploy
```

### Issue: Rule Function Fails with "Cannot find module 'stock-utils'"
The Lambda layer may not be attached. Check:
```bash
aws lambda get-function-configuration \
  --function-name stock-alert-rule1 \
  --query 'Layers'
```

Should show the stock-utils layer ARN. If missing, redeploy.

### Issue: Config API Returns 500 Error
Check CloudWatch logs:
```bash
aws logs tail /aws/lambda/stock-alerts-config-api --since 10m
```

Common causes:
- Missing IAM permissions (should be auto-created by SAM)
- Function name mismatch in config-api.js

### Issue: Orchestrator Can't Invoke Rules
Check IAM permissions:
```bash
aws lambda get-policy --function-name stock-alert-rule1
```

Should allow invocations from the orchestrator function.

## Manual Cleanup

To delete the entire stack:
```bash
sam delete --stack-name stock-alerts-v2
```

This removes:
- All Lambda functions
- Lambda layer
- API Gateway
- CloudWatch log groups
- IAM roles
- EventBridge schedule

## Next Steps

1. Test the UI at https://main.djiqwmbk5ujjm.amplifyapp.com/
2. Click "Test Rule 1" to verify individual rule triggering
3. Wait for 10 AM EST to verify automatic daily execution
4. Monitor Slack channel for alerts
5. Adjust thresholds via UI as needed
