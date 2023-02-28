"use strict";

require("source-map-support/register");
const {
  _
} = require('@genx/july');
const {
  tryRequire
} = require('@genx/sys');
const AmqpNode = tryRequire('amqplib');
const Connector = require('../../Connector');
const MessageContentType = 'application/json';
class RabbitmqConnector extends Connector {
  constructor(connectionString, options) {
    super('rabbitmq', connectionString, options);
  }
  async end_() {
    delete this.acitveConnections;
    if (this.conn) {
      await this.conn.close();
    }
    delete this.conn;
  }
  async connect_(options) {
    if (!this.conn) {
      this.conn = await AmqpNode.connect(this.connectionString);
      this.log('verbose', `rabbitmq: successfully connected to "${this.getConnectionStringWithoutCredential()}".`);
      this.conn.on('error', async err => {
        this.log('error', `rabbitmq: connection error: ${err}}`);
      });
      if (this.options.logger) {
        this.conn.on('blocked', reason => {
          this.log('warn', `rabbitmq: connection is blocked. ${reason}`);
        });
        this.conn.on('unblocked', () => {
          this.log('info', 'rabbitmq: connection is unblocked.');
        });
      }
    }
    const opts = {
      direction: 'out',
      ...options
    };
    const chKey = opts.exchange ? `[X]${opts.exchange}|${opts.direction}` : `[Q]${opts.queue}|${opts.direction}`;
    this.acitveConnections || (this.acitveConnections = {});
    let ch = this.acitveConnections[chKey];
    if (!ch) {
      ch = await this.conn.createChannel();
      ch.on('error', async err => {
        this.log('error', `rabbitmq: channel error. ${err}`);
      });
      this.acitveConnections[chKey] = ch;
      this.log('verbose', `rabbitmq: new channel created for queue "${chKey}".`);
    }
    return ch;
  }
  async disconnect_(ch) {
    this.log('verbose', 'rabbitmq: channel closed.');
    if (this.acitveConnections) {
      this.acitveConnections = _.omit(this.acitveConnections, conn => conn === ch);
    }
  }
  async ping_() {
    return true;
  }
  async sendToWorkers_(queue, obj) {
    const ch = await this.connect_({
      queue,
      direction: 'out'
    });
    await ch.assertQueue(queue, {
      durable: true
    });
    const ret = await ch.sendToQueue(queue, Buffer.from(JSON.stringify(obj)), {
      persistent: true,
      content_type: MessageContentType
    });
    const logMsg = `rabbitmq: new message enqueued to [${queue}].`;
    if (this.options.logMessage) {
      this.log('verbose', logMsg, {
        msg: obj
      });
    } else {
      this.log('verbose', logMsg);
    }
    return ret;
  }
  async workerConsume_(queue, consumerMethod) {
    const ch = await this.connect_({
      queue,
      direction: 'in'
    });
    await ch.assertQueue(queue, {
      durable: true
    });
    await ch.prefetch(1);
    const logMsg = `rabbitmq: new message dequeued from [${queue}].`;
    return ch.consume(queue, msg => {
      if (this.options.logMessage) {
        this.log('verbose', logMsg, {
          msg: msg.content.toString()
        });
      } else {
        this.log('verbose', logMsg);
      }
      return consumerMethod(ch, msg);
    }, {
      noAck: false
    });
  }
  async publish_(exchange, obj, routeKey) {
    const ch = await this.connect_({
      exchange,
      direction: 'out'
    });
    await ch.assertExchange(exchange, 'fanout', {
      durable: false
    });
    const ret = await ch.publish(exchange, routeKey || '', Buffer.from(JSON.stringify(obj)), {
      content_type: MessageContentType
    });
    const logMsg = `rabbitmq: new message published to exchange [${exchange}].`;
    if (this.options.logMessage) {
      this.log('verbose', logMsg, {
        msg: obj
      });
    } else {
      this.log('verbose', logMsg);
    }
    return ret;
  }
  async subscribe_(exchange, subscriberMethod, routeKey) {
    const ch = await this.connect_({
      exchange,
      direction: 'in'
    });
    await ch.assertExchange(exchange, 'fanout', {
      durable: false
    });
    const q = await ch.assertQueue('', {
      exclusive: true
    });
    await ch.bindQueue(q.queue, exchange, routeKey || '');
    const logMsg = `rabbitmq: new message received from exchange [${exchange}].`;
    return ch.consume(q.queue, msg => {
      if (this.options.logMessage) {
        this.log('verbose', logMsg, {
          msg: msg.content.toString()
        });
      } else {
        this.log('verbose', logMsg);
      }
      return subscriberMethod(ch, msg);
    }, {
      noAck: true
    });
  }
}
RabbitmqConnector.driverLib = AmqpNode;
module.exports = RabbitmqConnector;
//# sourceMappingURL=Connector.js.map