// Newer Lambda Function URLs need BOTH lambda:InvokeFunctionUrl and lambda:InvokeFunction (invoked via URL). Older AWS CLIs lack the flag for the second, so use the SDK.
import { LambdaClient, AddPermissionCommand } from '@aws-sdk/client-lambda';
const c = new LambdaClient({ region: 'us-east-1' });
try { await c.send(new AddPermissionCommand({ FunctionName: process.argv[2], StatementId: 'url-public-invoke', Action: 'lambda:InvokeFunction', Principal: '*', InvokedViaFunctionUrl: true })); console.log('permission added'); }
catch (e) { if (e.name === 'ResourceConflictException') console.log('permission already present'); else throw e; }
