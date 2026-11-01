import { createDemoServer } from '../../server.mjs';

const app = createDemoServer({ dbPath: process.argv[2] });
const address = await app.listen(0);
process.send?.({ port: address.port });
