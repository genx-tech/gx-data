const { waitUntil_ } = require('rk-utils');

class Bulk {
    constructor(limit, bulkAction, total) {
        this.limit = limit; 
        this.itemsTotal = total;
        this.bulkAction = bulkAction;

        this.itemsPending = 0;
        this.itemsDone = 0;
        this.itemsError = 0;
        this._buffer = [];              
    }

    flush() {        
        if (this._buffer.length > 0) {
            let bulkItems = this._buffer.concat();
            this._buffer = [];

            let l = bulkItems.length;
            this.itemsPending += l;

            Promise.resolve(this.bulkAction(bulkItems)).then(async () => {
                this.itemsDone += l;

                if (this.onProgress) {
                    this.onProgress(this.itemsPending, this.itemsDone, this.itemsTotal);
                }
            }).catch(error => {
                this.itemsDone += l;
                this.itemsError += l;

                if (this.onError) {
                    this.onError(error, this.itemsError);
                }
            });
        }
    }

    add(item) {
        this._buffer.push(item);

        if (this._buffer.length >= this.limit) {
            this.flush();
        }
    }

    async waitToEnd_(interval, maxRounds) {
        return waitUntil_(() => this.itemsDone >= this.itemsPending, interval, maxRounds);
    }
}

module.exports = Bulk;