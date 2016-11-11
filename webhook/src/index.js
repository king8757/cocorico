import 'babel-polyfill';

import cluster from 'cluster';

import Logger from 'cocorico-logger';

const logger = new Logger('webhook-service');

if (cluster.isMaster) {

  logger.info('spawning consumers');

  for (var i = 0; i < 5; i++) {
    cluster.fork();
  }

  logger.info('consumers started');

  // If a worker exits, we wait 30 seconds and restart it.
  cluster.on('exit', (deadWorker, code, signal) => {
    logger.info({workerId: deadWorker.id}, 'consumer exited, waiting 30s');

    setTimeout(
      () => {
        var newWorker = cluster.fork();

        logger.info({workerId: newWorker.id}, 'restarted consumer');
      },
      30000
    );
  });
} else {
  var webhookConsumer = require('./webhook-consumer');

  webhookConsumer.run();
}
