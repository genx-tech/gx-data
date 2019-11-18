const { Promise } = require('rk-utils');
const { tryRequire } = require('../../utils/lib');
const AmqpNode = tryRequire('amqplib');
const Connector = require('../../Connector');

/**
 * A callback function to be called to handle a dequeued message.
 * @callback workerFunction
 * @param {Channel} ch - MQ Channel object
 * @param {Message} msg - Message object
 */

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
        if (this.ch) {
            await this.disconnect_(this.ch);
        }

        if (this.conn) {
            await this.conn.close();
        }

        delete this.conn;
    }

    /**
     * Create a database connection based on the default connection string of the connector and given options.     
     * @param {Object} [options] - Extra options for the connection, optional.
     * @property {bool} [options.multipleStatements=false] - Allow running multiple statements at a time.
     * @property {bool} [options.createDatabase=false] - Flag to used when creating a database.
     * @returns {Promise.<Db>}
     */
    async connect_() {
        if (!this.conn) {
            this.conn = await AmqpNode.connect(this.connectionString);
            this.log('verbose', `rabbitmq: successfully connected to "${this.getConnectionStringWithoutCredential()}".`);            

            this.conn.on('close', async () => {
                return this.end_();
            });

            this.conn.on('error', async err => {
                this.log('error', `rabbitmq: connection error: ${err}}`);
                return this.end_();
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

        if (!this.ch) {
            this.ch = await this.conn.createChannel();

            this.ch.on('close', async () => {
                return this.disconnect_(this.ch);
            });

            this.ch.on('error', async err => {
                this.log('error', `rabbitmq: channel error. ${err}`);
                return this.disconnect_(this.ch);
            });            

            this.log('verbose', 'rabbitmq: new channel created.');            
        }

        return this.ch;
    }

    /**
     * Close a database connection.
     * @param {Db} conn - MySQL connection.
     */
    async disconnect_(ch) {
        this.log('info', 'rabbitmq: channel closed.');

        await ch.close();

        if (this.ch === ch) {
            delete this.ch;        
        }                
    }

    async ping_() {
        return true;
    }
  
    /**
     * Send a message to worker queue.
     * @see https://www.rabbitmq.com/tutorials/tutorial-two-javascript.html
     * @param {*} queueName 
     * @param {*} obj 
     */
    async sendToWorkers_(queueName, obj) {
        if (typeof obj !== 'string') {
            obj = JSON.stringify(obj);
        }

        let ch = await this.connect_();  

        await ch.assertQueue(queueName, {
            durable: true
        });

        let ret = await ch.sendToQueue(queueName, Buffer.from(obj), {
            persistent: true
        });

        let logMsg = `rabbitmq: new message enqueued to [${queueName}].`;

        if (this.options.logMessage) {
            this.log('info', logMsg, { msg: obj });
        } else {
            this.log('info', logMsg);
        }       

        return ret;
    }   

    /**
     * Waiting for message from a queue by a worker.
     * @see https://www.rabbitmq.com/tutorials/tutorial-two-javascript.html
     * @param {*} queueName 
     * @param {workerFunction} consumerMethod 
     */
    async workerConsume_(queueName, consumerMethod) {        
        let ch = await this.connect_();

        await ch.assertQueue(queueName, {
            durable: true
        });

        await ch.prefetch(1);

        let logMsg = `rabbitmq: new message dequeued from [${queueName}].`;

        return ch.consume(queueName, (msg) => { 
            if (this.options.logMessage) {
                this.log('info', logMsg, { msg: msg.content });
            } else {
                this.log('info', logMsg);
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
        if (typeof obj !== 'string') {
            obj = JSON.stringify(obj);
        }

        let ch = await this.connect_();   

        await ch.assertExchange(exchange, 'fanout', {
            durable: false
        });

        let ret = await ch.publish(exchange, routeKey || '', Buffer.from(obj));

        let logMsg = `rabbitmq: new message published to exchange [${exchange}].`;

        if (this.options.logMessage) {
            this.log('info', logMsg, { msg: obj });
        } else {
            this.log('info', logMsg);
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
        let ch = await this.connect_();

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
                this.log('info', logMsg, { msg: msg.content });
            } else {
                this.log('info', logMsg);
            }       

            return subscriberMethod(ch, msg); 
        }, {
            // auto acknowledgment mode
            noAck: true
        });
    }
}

module.exports = RabbitmqConnector;