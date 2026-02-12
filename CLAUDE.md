# Stock Alerts Application

## Overview
A stock alert system that monitors S&P 500 stocks and sends Slack notifications based on configurable rules.

## Architecture

### Frontend
- `index.html` - Configuration UI hosted on AWS Amplify
- Single-page app with toggle switches and threshold inputs for 6 alert rules

### Backend (AWS Lambda)
- `lambda/stock-alerts.js` - Main alert function, runs daily at 10 AM EST
- `lambda/config-api.js` - REST API for reading/updating configuration

### AWS Resources
- **Lambda Functions:**
  - `stock-drop-alert` - Main alert processor (180s timeout, 256MB)
  - `stock-alerts-config-api` - Configuration API (90s timeout)
- **API Gateway:** `https://hkiacme8v5.execute-api.us-east-1.amazonaws.com/prod/config`
- **EventBridge:** Schedule rule for weekday 10 AM EST runs
- **IAM Roles:** `stock-alerts-lambda-role`, `stock-alerts-api-role`

## Alert Rules

### Downside Alerts
1. **1-Day Drop** - Stock dropped >X% today
2. **2-Day Drop** - Stock dropped >X% over 2 days

### Upside Potential Alerts
3. **Recovery Signal** - Dropped >X% in 5 days but UP >Y% today
4. **Near 52-Week Low** - Within X% of 52-week low
5. **Bounce Back** - Dropped >X% yesterday but up >Y% today
6. **High Volume Surge** - Up >X% with volume >Y times average

## Data Source
- Yahoo Finance API (fetched live on each run)
- ~450 stocks monitored (S&P 500 + popular growth stocks)
- Batch processing: 15 stocks per batch, 500ms delay between batches

## Slack Integration
- Webhook: Configured in Lambda environment variable `SLACK_WEBHOOK_URL`
- Channel: #stock-alerts

## Deployment
```bash
# Deploy stock-alerts Lambda
cd lambda && zip -r ../stock-alerts.zip stock-alerts.js
aws lambda update-function-code --function-name stock-drop-alert --zip-file fileb://stock-alerts.zip --region us-east-1

# Deploy config-api Lambda
zip -r ../config-api.zip config-api.js
aws lambda update-function-code --function-name stock-alerts-config-api --zip-file fileb://config-api.zip --region us-east-1
```

## GitHub
- Repository: https://github.com/aviramshm/nasdaq-stocks
- Auto-deploys to AWS Amplify on push
