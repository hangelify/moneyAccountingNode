// test-env.ts turns batch parsing off. AppModule reads BILL_BATCH_ENABLED
// when it is first imported, so a spec that needs the queue, worker and
// events hub imports this module before anything that pulls in AppModule.
process.env.BILL_BATCH_ENABLED = 'true';
