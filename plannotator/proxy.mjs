import {createReviewServer} from './server/review-server.mjs';

const [state, portText = '19433'] = process.argv.slice(2);
const port = Number(portText);
const server = createReviewServer(state, port);
server.listen(port, '127.0.0.1', () => console.log(`Review proxy listening on 127.0.0.1:${port}`));
