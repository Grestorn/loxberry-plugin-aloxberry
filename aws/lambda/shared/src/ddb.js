'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

// Module-scope cache: the SDK client is reused across warm invocations.
let _docClient;

function getDocClient() {
  if (!_docClient) {
    const base = new DynamoDBClient({});
    _docClient = DynamoDBDocumentClient.from(base, {
      marshallOptions: {
        // Treat undefined as "do not write the attribute" rather than NULL —
        // matches typical JS object semantics.
        removeUndefinedValues: true,
        convertClassInstanceToMap: false,
      },
      unmarshallOptions: {
        wrapNumbers: false,
      },
    });
  }
  return _docClient;
}

const tableNames = Object.freeze({
  users: process.env.USERS_TABLE,
  authCodes: process.env.AUTHCODES_TABLE,
  // Operator-tunable runtime config (e.g. the beta connection cap). Only the
  // oauth-handler reads/writes this; undefined in Lambdas that don't set the
  // CONFIG_TABLE env var, which is fine — they never touch tableNames.config.
  config: process.env.CONFIG_TABLE,
});

module.exports = { getDocClient, tableNames };
