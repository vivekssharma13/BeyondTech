const path = require('node:path');
const { importHistoricalMarketCsv } = require('../services/market_data_service');
const { startWorkflow, completeWorkflow, failWorkflow, startComponent, completeComponent, failComponent } = require('../services/workflow_service');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const csvPath = argument('--file');
const manifestPath = argument('--manifest');
if (!csvPath || !manifestPath) {
  console.error('Usage: node scripts/import_market_csv.js --file <prices.csv> --manifest <manifest.json>');
  process.exit(2);
}

const workflow = startWorkflow({
  workflowType: 'MARKET_DATA_IMPORT',
  metadata: { csvFilename: path.basename(csvPath), manifestFilename: path.basename(manifestPath) },
});
const execution = startComponent({
  workflowId: workflow.workflowId,
  component: 'MARKET_DATA_INGESTION',
  sourceType: 'OBSERVED_MARKET_PRICE',
  input: { csvFilename: path.basename(csvPath), manifestFilename: path.basename(manifestPath) },
});

try {
  const result = importHistoricalMarketCsv({ csvPath, manifestPath });
  completeComponent(execution, { sourceType: 'OBSERVED_MARKET_PRICE', output: result });
  completeWorkflow(workflow, result);
  console.log(JSON.stringify({ ...result, workflowId: workflow.workflowId }, null, 2));
} catch (error) {
  failComponent(execution, error, { code: error.code, details: error.details });
  failWorkflow(workflow, error);
  console.error(JSON.stringify({ error: { code: error.code || 'MARKET_IMPORT_FAILED', message: error.message, details: error.details || {} }, workflowId: workflow.workflowId }, null, 2));
  process.exit(1);
}
