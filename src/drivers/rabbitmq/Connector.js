const { _ } = require('@genx/july');
const { tryRequire } = require('@genx/sys');
const AmqpNode = tryRequire('amqplib', __dirname);
const Connector = require('../../Connector');

/**
 * A callback function to be called to handle a dequeued message.
 * @callback workerFunction
 * @param {Channel} ch - MQ Channel object
 * @param {Message} msg - Message object
 */

const MessageContentType = 'application/json';

/**
 * Rabbitmq data storage connector.
 * @class
 * @extends Connector
 */
class RabbitmqConnector extends Connector {
    /**          
     * @param {string} name 
     * @param {object} options      
     * @property {boolean} [options.logMessage] - Flag to log queued message
     */
    constructor(connectionString, options) {        
        super('rabbitmq', connectionString, options);  
    }

    /**
     * Close all connection initiated by this connector.
     */
    async end_() {        
        delete this.acitveConnections;

        if (this.conn) {
            await this.conn.close();
        }

        delete this.conn;
    }

    /**
     * Create a database connection based on the default connection string of the connector and given options.     
     * @param {Object} [options] - Extra options for the connection, optional.
     * @property {string} [options.queue] - Connection for queue, default ''
     * @property {string} [options.exchange] - Connection for queue, default ''
     * @property {string} [options.direction] - Connection for queue, default ''
     * @returns {Promise.<Db>}
     */
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
        
        let opts = {            
            direction: 'out',
            ...options
        };

        let chKey = opts.exchange ? (`[X]${opts.exchange}|${opts.direction}`) : (`[Q]${opts.queue}|${opts.direction}`);

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

    /**
     * Close a database connection.
     * @param {Db} conn - MySQL connection.
     */
    async disconnect_(ch) {
        this.log('verbose', 'rabbitmq: channel closed.');

        if (this.acitveConnections) {
            this.acitveConnections = _.omit(this.acitveConnections, conn => conn === ch);
        }
    }

    async ping_() {
        return true;
    }
  
    /**
     * Send a message to worker queue.
     * @see https://www.rabbitmq.com/tutorials/tutorial-two-javascript.html
     * @param {*} queue 
     * @param {*} obj 
     */
    async sendToWorkers_(queue, obj) {
        let ch = await this.connect_({ queue, direction: 'out' });  

        await ch.assertQueue(queue, {
            durable: true
        });

        let ret = await ch.sendToQueue(queue, Buffer.from(JSON.stringify(obj)), {
            persistent: true,
            content_type: MessageContentType
        });

        let logMsg = `rabbitmq: new message enqueued to [${queue}].`;

        if (this.options.logMessage) {
            this.log('verbose', logMsg, { msg: obj });
        } else {
            this.log('verbose', logMsg);
        }       

        return ret;
    }   

    /**
     * Waiting for message from a queue by a worker.
     * @see https://www.rabbitmq.com/tutorials/tutorial-two-javascript.html
     * @param {*} queue 
     * @param {workerFunction} consumerMethod 
     */
    async workerConsume_(queue, consumerMethod) {        
        let ch = await this.connect_({ queue, direction: 'in' });

        await ch.assertQueue(queue, {
            durable: true
        });

        await ch.prefetch(1);

        let logMsg = `rabbitmq: new message dequeued from [${queue}].`;

        return ch.consume(queue, (msg) => { 
            if (this.options.logMessage) {
                this.log('verbose', logMsg, { msg: msg.content.toString() });
            } else {
                this.log('verbose', logMsg);
            }       

            return consumerMethod(ch, msg); 
        }, {
            // manual acknowledgment mode
            // need send a proper acknowledgment from the worker, once done with a task.
            noAck: false
        });
    }

    /**
     * Publish a message to all subscribers.
     * @param {*} exchange 
     * @param {*} obj 
     * @param {*} routeKey 
     */
    async publish_(exchange, obj, routeKey) {
        let ch = await this.connect_({ exchange, direction: 'out' });   

        await ch.assertExchange(exchange, 'fanout', {
            durable: false
        });

        let ret = await ch.publish(exchange, routeKey || '', Buffer.from(JSON.stringify(obj)), {
            content_type: MessageContentType
        });

        let logMsg = `rabbitmq: new message published to exchange [${exchange}].`;

        if (this.options.logMessage) {
            this.log('verbose', logMsg, { msg: obj });
        } else {
            this.log('verbose', logMsg);
        }       

        return ret;
    }

    /**
     * Subscribe to a message exchange.
     * @param {*} exchange 
     * @param {workerFunction} subscriberMethod 
     * @param {*} routeKey 
     */
    async subscribe_(exchange, subscriberMethod, routeKey) {
        let ch = await this.connect_({ exchange, direction: 'in' });

        await ch.assertExchange(exchange, 'fanout', {
            durable: false
        });

        let q = await ch.assertQueue('', {
            exclusive: true
        });

        await ch.bindQueue(q.queue, exchange, routeKey || '');

        let logMsg = `rabbitmq: new message dequeued from [${queueName}].`;

        return ch.consume(q.queue, (msg) => { 
            if (this.options.logMessage) {
                this.log('verbose', logMsg, { msg: msg.content.toString() });
            } else {
                this.log('verbose', logMsg);
            }       

            return subscriberMethod(ch, msg); 
        }, {
            // auto acknowledgment mode
            noAck: true
        });
    }
}

RabbitmqConnector.driverLib = AmqpNode;

module.exports = RabbitmqConnector;