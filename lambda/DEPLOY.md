# Stock Alert Lambda Deployment Guide

This guide walks you through deploying the Stock Drop Alert Lambda function to AWS.

## Prerequisites

1. AWS CLI installed and configured
2. AWS SAM CLI installed (`brew install aws-sam-cli` on Mac)
3. Slack Webhook URL (see below)

## Step 1: Create Slack Webhook

1. Go to https://api.slack.com/apps
2. Click **"Create New App"** → **"From scratch"**
3. Name: "Stock Alerts", select your workspace
4. Go to **"Incoming Webhooks"** in sidebar
5. Toggle **"Activate Incoming Webhooks"** to On
6. Click **"Add New Webhook to Workspace"**
7. Select **#stock-alerts** channel → **Allow**
8. Copy the Webhook URL

## Step 2: Deploy with SAM

```bash
cd lambda

# Build the application
sam build

# Deploy (first time - guided)
sam deploy --guided
```

When prompted:
- **Stack Name:** stock-alerts
- **AWS Region:** us-east-1 (or your preferred region)
- **SlackWebhookUrl:** Paste your Slack webhook URL
- **DropThreshold:** 5 (or your preferred percentage)
- **AlertEnabled:** true

## Step 3: Test the Function

```bash
# Invoke manually to test
aws lambda invoke \
  --function-name stock-drop-alert \
  --payload '{}' \
  response.json

cat response.json
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL | Required |
| `DROP_THRESHOLD` | Minimum % drop to trigger alert | 5 |
| `ALERT_ENABLED` | Enable/disable alerts | true |

### Schedule

The function runs:
- **Time:** 10:00 AM EST (15:00 UTC)
- **Days:** Monday through Friday
- **Cron:** `cron(0 15 ? * MON-FRI *)`

### Modifying the Schedule

To change the schedule, update the `Schedule` property in `template.yaml`:

```yaml
Schedule: cron(0 15 ? * MON-FRI *)  # 10 AM EST weekdays
```

Common cron patterns:
- `cron(0 14 ? * MON-FRI *)` - 10 AM EST during DST
- `cron(0 15 ? * * *)` - 10 AM EST every day
- `cron(0 21 ? * MON-FRI *)` - 4 PM EST weekdays (market close)

## Update Configuration

To update settings after deployment:

```bash
# Update environment variables
aws lambda update-function-configuration \
  --function-name stock-drop-alert \
  --environment "Variables={SLACK_WEBHOOK_URL=https://hooks.slack.com/...,DROP_THRESHOLD=7,ALERT_ENABLED=true}"
```

Or redeploy with SAM:

```bash
sam deploy --parameter-overrides SlackWebhookUrl=YOUR_URL DropThreshold=7 AlertEnabled=true
```

## Enable/Disable Alerts

```bash
# Disable
aws lambda update-function-configuration \
  --function-name stock-drop-alert \
  --environment "Variables={ALERT_ENABLED=false,...}"

# Enable
aws lambda update-function-configuration \
  --function-name stock-drop-alert \
  --environment "Variables={ALERT_ENABLED=true,...}"
```

## Monitoring

View logs in CloudWatch:
```bash
aws logs tail /aws/lambda/stock-drop-alert --follow
```

## Costs

Estimated monthly cost: **~$0.01 - $0.05**
- Lambda: ~20 invocations/month × ~10 seconds = minimal
- CloudWatch Events: Free tier covers this
- CloudWatch Logs: Minimal storage

## Troubleshooting

### No alerts received
1. Check Lambda logs in CloudWatch
2. Verify ALERT_ENABLED is "true"
3. Verify Slack webhook URL is correct
4. Check if any stocks actually dropped > threshold

### Function timeout
- Increase timeout in template.yaml (default: 60s)
- Check network connectivity to Yahoo Finance

### Slack webhook error
- Verify webhook URL is correct and active
- Check Slack app permissions
