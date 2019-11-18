"use strict";

const path = require('path');
const util = require('util');
const Util = require('../../util.js');
const Promise = Util.Promise;
const Convertors = require('./convertors');

class I18n {
    /**
     * An app module object.
     * @constructs I18n
     * @param {object} [config] - The i18n configuration.
     * @property {array} [config.supportedLocales] - The default locale
     * @property {bool} [config.reverseUpdate=false] - Reverse update when
     * @property {bool} [config.updateWithMeta=false] -
     * @property {string} [config.timezone] - Timezone
     */
    constructor(config) {
        config || (config = {});

        this.supportedLocales = config.supportedLocales ? config.supportedLocales.map(l => I18n.normalizeLocale(l)) : [ 'en_AU', 'en_US', 'zh_CN' ];
        this.reverseUpdate = util.isNullOrUndefined(config.reverseUpdate) ? false :  Convertors.toBoolean(config.reverseUpdate);
        this.updateWithMeta = util.isNullOrUndefined(config.updateWithMeta) ? false : Convertors.toBoolean(config.updateWithMeta);
        this.timezone = config.timezone;
        this.pendingUpdates = {};
    }

    isLocaleSupported(locale) {
        let n = locale && I18n.normalizeLocale(locale);
        return this.supportedLocales.some(l => n === l);
    }

    async setupAsync(locale) {
        if (!this.isLocaleSupported(locale)) return Promise.reject('unsupported_locale');

        this.dictionary = {};

        this.locale = I18n.normalizeLocale(locale || this.supportedLocales[0]);
        this.momentLocale = I18n.localeToDash(this.locale).toLowerCase();
        this.momentTimezone = Util.timezone;

        return this;
    }

    getText(token, values, defaultText) {
        if (Util._.isString(values)) {
            defaultText = values;
            values = null;
        }

        var phrase = Util.getValueByPath(this.dictionary, token);

        if (util.isNullOrUndefined(phrase)) {
            phrase = defaultText;

            if (phrase) {
                if (this.reverseUpdate) this.addToDictionary(token, phrase);
            } else {
                phrase = token;
            }
        } else if (util.isObject(phrase)) {
            phrase = phrase['text'];
        }

        return Util._.isEmpty(values) ? phrase : Util.template(phrase, values);
    }

    addToDictionary(token, text, saveImmediate) {
        if (this.updateWithMeta) {
            text = { text: text, comment: 'Added at ' + this.datetime().format() }
        }

        Util.setValueByPath(this.dictionary, token, text);

        this.pendingUpdates[token] = text;

        if (saveImmediate) {
            this.save();
        }
    }

    save() {
        this.pendingUpdates = {};
    }

    datetime(value, timezone) {
        timezone || (timezone = this.timezone);

        var r = this.momentTimezone(value).locale(this.momentLocale);

        return timezone ? r.tz(timezone) : r;
    }

    flush() {
        if (this.reverseUpdate) { this.save(); }
    }

    get dashForm() {
        return I18n.localeToDash(this.locale);
    }

    static normalizeLocale(locale) {
        var l = locale.replace('-', '_').split('_', 2);
        var l2 = l[0].toLowerCase();
        if (l.length > 1) {
            l2 += '_' + l[1].toUpperCase();
        }
        return l2;
    }

    static localeToDash(locale) {
        return locale.replace('_', '-');
    }

    static extractLanguageCode(locale) {
        var pos = locale.lastIndexOf('_');
        if (pos == -1) return locale;

        return locale.substr(0, pos);
    }

    static extractCountryCode(locale) {
        var pos = locale.lastIndexOf('_');
        if (pos == -1) return '';

        return locale.substr(pos + 1);
    }    
}

class FileI18n extends I18n {

    constructor(config) {
        super(config);

        config || (config = {});

        this.directory = config.directory || './locale';
    }

    async setupAsync(locale) {
        const self = this;

        function loadDir(dict, dir, finish) {
            Util.fs.readdir(dir, function (err, files) {
                if (err) return finish(err);

                Util.async.each(files, function (file, cb) {
                    let langFilePath = path.join(dir, file);
                    let stats = Util.fs.statSync(langFilePath);

                    if (stats.isDirectory()) {
                        dict[file] = {};
                        return loadDir(dict[file], langFilePath, cb);
                    }

                    let extName = path.extname(file);
                    if (extName.toLowerCase() !== '.json') return cb();

                    Util.fs.readJson(langFilePath, function (err, content) {
                        if (err) return cb(err);

                        let basename = path.basename(file, extName);
                        dict[basename] = content;

                        cb();
                    });

                }, finish);
            });
        }

        return super.setupAsync(locale).then(() => {
            let langPath = path.resolve(self.directory, 'lang');

            return new Promise((resolve, reject) => {
                let p = path.join(langPath, self.locale);

                if (!Util.fs.existsSync(p)) {
                    //try only language code
                    let lang = I18n.extractLanguageCode(self.locale);
                    p = path.join(langPath, lang);

                    if (!Util.fs.existsSync(p)) {
                        return resolve(self);
                    }
                }

                loadDir(self.dictionary, p, (err) => {
                    if (err) return reject(err);
                    resolve(self);
                });
            });
        });
    }

    save() {
        var fileSet = new Set();

        Util._.forOwn(this.pendingUpdates, (v, k) => {
            let keyword = path.extname(k);
            let p = path.basename(k, keyword);
            fileSet.add(p);
        });

        var langPath = path.resolve(this.directory, 'lang');
        var bp = path.join(langPath, this.locale);

        for (let p of fileSet) {
            let content = Util.getValueByPath(this.dictionary, p);
            let f = Util.replaceAll(p, '.', path.delimiter) + '.json';

            Util.fs.outputJsonSync(path.join(bp, f), content);
        }

        fileSet.clear();

        super.save();
    }
}

I18n.File = FileI18n;

module.exports = I18n;