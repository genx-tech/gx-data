"use strict";

require("source-map-support/register");

const EventEmitter = require('events');

const path = require('path');

const Util = require('rk-utils');

const {
  _,
  fs,
  quote,
  putIntoBucket
} = Util;

const OolUtils = require('../../../lang/OolUtils');

const {
  pluralize,
  isDotSeparateName,
  extractDotSeparateName
} = OolUtils;

const Entity = require('../../../lang/Entity');

const Types = require('../../../runtime/types');

const UNSUPPORTED_DEFAULT_VALUE = new Set(['BLOB', 'TEXT', 'JSON', 'GEOMETRY']);

class MySQLModeler {
  constructor(context, connector, dbOptions) {
    this.logger = context.logger;
    this.linker = context.linker;
    this.outputPath = context.scriptOutputPath;
    this.connector = connector;
    this._events = new EventEmitter();
    this._dbOptions = dbOptions ? {
      db: _.mapKeys(dbOptions.db, (value, key) => _.upperCase(key)),
      table: _.mapKeys(dbOptions.table, (value, key) => _.upperCase(key))
    } : {};
    this._references = {};
    this._relationEntities = {};
    this._processedRef = new Set();
  }

  modeling(schema, schemaToConnector) {
    this.logger.log('info', 'Generating mysql scripts for schema "' + schema.name + '"...');
    let modelingSchema = schema.clone();
    this.logger.log('debug', 'Building relations...');
    let pendingEntities = Object.keys(modelingSchema.entities);

    while (pendingEntities.length > 0) {
      let entityName = pendingEntities.shift();
      let entity = modelingSchema.entities[entityName];

      if (!_.isEmpty(entity.info.associations)) {
        this.logger.log('debug', `Processing associations of entity "${entityName}"...`);

        let assocs = this._preProcessAssociations(entity);

        let assocNames = assocs.reduce((result, v) => {
          result[v] = v;
          return result;
        }, {});
        entity.info.associations.forEach(assoc => this._processAssociation(modelingSchema, entity, assoc, assocNames, pendingEntities));
      }
    }

    this._events.emit('afterRelationshipBuilding');

    let sqlFilesDir = path.join('mysql', this.connector.database);
    let dbFilePath = path.join(sqlFilesDir, 'entities.sql');
    let fkFilePath = path.join(sqlFilesDir, 'relations.sql');
    let tableSQL = '',
        relationSQL = '',
        data = {};

    _.each(modelingSchema.entities, (entity, entityName) => {
      if (!(entityName === entity.name)) {
        throw new Error("Assertion failed: entityName === entity.name");
      }

      entity.addIndexes();
      let result = MySQLModeler.complianceCheck(entity);

      if (result.errors.length) {
        let message = '';

        if (result.warnings.length > 0) {
          message += 'Warnings: \n' + result.warnings.join('\n') + '\n';
        }

        message += result.errors.join('\n');
        throw new Error(message);
      }

      if (entity.features) {
        _.forOwn(entity.features, (f, featureName) => {
          if (Array.isArray(f)) {
            f.forEach(ff => this._featureReducer(modelingSchema, entity, featureName, ff));
          } else {
            this._featureReducer(modelingSchema, entity, featureName, f);
          }
        });
      }

      tableSQL += this._createTableStatement(entityName, entity) + '\n';

      if (entity.info.data) {
        entity.info.data.forEach(({
          dataSet,
          runtimeEnv,
          records
        }) => {
          let entityData = [];

          if (Array.isArray(records)) {
            records.forEach(record => {
              if (!_.isPlainObject(record)) {
                let fields = Object.keys(entity.fields);

                if (fields.length !== 2) {
                  throw new Error(`Invalid data syntax: entity "${entity.name}" has more than 2 fields.`);
                }

                let keyField = entity.fields[fields[0]];

                if (!keyField.auto && !keyField.defaultByDb) {
                  throw new Error(`The key field "${entity.name}" has no default value or auto-generated value.`);
                }

                record = {
                  [fields[1]]: this.linker.translateOolValue(entity.oolModule, record)
                };
              } else {
                record = this.linker.translateOolValue(entity.oolModule, record);
              }

              entityData.push(record);
            });
          } else {
            _.forOwn(records, (record, key) => {
              if (!_.isPlainObject(record)) {
                let fields = Object.keys(entity.fields);

                if (fields.length !== 2) {
                  throw new Error(`Invalid data syntax: entity "${entity.name}" has more than 2 fields.`);
                }

                record = {
                  [entity.key]: key,
                  [fields[1]]: this.linker.translateOolValue(entity.oolModule, record)
                };
              } else {
                record = Object.assign({
                  [entity.key]: key
                }, this.linker.translateOolValue(entity.oolModule, record));
              }

              entityData.push(record);
            });
          }

          if (!_.isEmpty(entityData)) {
            dataSet || (dataSet = '_init');
            runtimeEnv || (runtimeEnv = 'default');
            let nodes = [dataSet, runtimeEnv];
            nodes.push(entityName);
            let key = nodes.join('.');
            putIntoBucket(data, key, entityData, true);
          }
        });
      }
    });

    _.forOwn(this._references, (refs, srcEntityName) => {
      _.each(refs, ref => {
        relationSQL += this._addForeignKeyStatement(srcEntityName, ref, schemaToConnector) + '\n';
      });
    });

    this._writeFile(path.join(this.outputPath, dbFilePath), tableSQL);

    this._writeFile(path.join(this.outputPath, fkFilePath), relationSQL);

    let initIdxFiles = {};

    if (!_.isEmpty(data)) {
      _.forOwn(data, (envData, dataSet) => {
        _.forOwn(envData, (entitiesData, runtimeEnv) => {
          _.forOwn(entitiesData, (records, entityName) => {
            let initFileName = `0-${entityName}.json`;
            let pathNodes = [sqlFilesDir, 'data', dataSet || '_init'];

            if (runtimeEnv !== 'default') {
              pathNodes.push(runtimeEnv);
            }

            let initFilePath = path.join(...pathNodes, initFileName);
            let idxFilePath = path.join(...pathNodes, 'index.list');
            putIntoBucket(initIdxFiles, [idxFilePath], initFileName);

            this._writeFile(path.join(this.outputPath, initFilePath), JSON.stringify({
              [entityName]: records
            }, null, 4));
          });
        });
      });
    }

    console.dir(initIdxFiles, {
      depth: 10
    });

    _.forOwn(initIdxFiles, (list, filePath) => {
      let idxFilePath = path.join(this.outputPath, filePath);
      let manual = [];

      if (fs.existsSync(idxFilePath)) {
        let lines = fs.readFileSync(idxFilePath, 'utf8').split('\n');
        lines.forEach(line => {
          if (!line.startsWith('0-')) {
            manual.push(line);
          }
        });
      }

      this._writeFile(idxFilePath, list.concat(manual).join('\n'));
    });

    let funcSQL = '';
    let spFilePath = path.join(sqlFilesDir, 'procedures.sql');

    this._writeFile(path.join(this.outputPath, spFilePath), funcSQL);

    return modelingSchema;
  }

  _toColumnReference(name) {
    return {
      oorType: 'ColumnReference',
      name
    };
  }

  _translateJoinCondition(context, localField, anchor, remoteField) {
    if (Array.isArray(remoteField)) {
      return remoteField.map(rf => this._translateJoinCondition(context, localField, anchor, rf));
    }

    if (_.isPlainObject(remoteField)) {
      let ret = {
        [localField]: this._toColumnReference(anchor + '.' + remoteField.by)
      };

      let withExtra = this._oolConditionToQueryCondition(context, remoteField.with);

      if (localField in withExtra) {
        return {
          $and: [ret, withExtra]
        };
      }

      return { ...ret,
        ...withExtra
      };
    }

    return {
      [localField]: this._toColumnReference(anchor + '.' + remoteField)
    };
  }

  _getAllRelatedFields(remoteField) {
    if (!remoteField) return undefined;

    if (Array.isArray(remoteField)) {
      return remoteField.map(rf => this._getAllRelatedFields(rf));
    }

    if (_.isPlainObject(remoteField)) {
      return remoteField.by;
    }

    return remoteField;
  }

  _preProcessAssociations(entity) {
    return entity.info.associations.map(assoc => {
      if (assoc.srcField) return assoc.srcField;

      if (assoc.type === 'hasMany') {
        return pluralize(assoc.destEntity);
      }

      return assoc.destEntity;
    });
  }

  _processAssociation(schema, entity, assoc, assocNames, pendingEntities) {
    let entityKeyField = entity.getKeyField();

    if (!!Array.isArray(entityKeyField)) {
      throw new Error("Assertion failed: !Array.isArray(entityKeyField)");
    }

    this.logger.log('debug', `Processing "${entity.name}" ${JSON.stringify(assoc)}`);
    let destEntityName = assoc.destEntity,
        destEntity,
        destEntityNameAsFieldName;

    if (isDotSeparateName(destEntityName)) {
      let [destSchemaName, actualDestEntityName] = extractDotSeparateName(destEntityName);
      let destSchema = schema.linker.schemas[destSchemaName];

      if (!destSchema.linked) {
        throw new Error(`The destination schema ${destSchemaName} has not been linked yet. Currently only support one-way reference for cross db relation.`);
      }

      destEntity = destSchema.entities[actualDestEntityName];
      destEntityNameAsFieldName = actualDestEntityName;
    } else {
      destEntity = schema.ensureGetEntity(entity.oolModule, destEntityName, pendingEntities);

      if (!destEntity) {
        throw new Error(`Entity "${entity.name}" references to an unexisting entity "${destEntityName}".`);
      }

      destEntityNameAsFieldName = destEntityName;
    }

    if (!destEntity) {
      throw new Error(`Entity "${entity.name}" references to an unexisting entity "${destEntityName}".`);
    }

    let destKeyField = destEntity.getKeyField();

    if (!destKeyField) {
      throw new Error(`Empty key field. Entity: ${destEntityName}`);
    }

    if (Array.isArray(destKeyField)) {
      throw new Error(`Destination entity "${destEntityName}" with combination primary key is not supported.`);
    }

    switch (assoc.type) {
      case 'hasOne':
      case 'hasMany':
        let includes;
        let excludes = {
          types: ['refersTo'],
          association: assoc
        };

        if (assoc.by) {
          excludes.types.push('belongsTo');
          includes = {
            by: cb => cb && cb.split('.')[0] === assoc.by.split('.')[0]
          };

          if (assoc.with) {
            includes.with = assoc.with;
          }
        } else {
          let remoteFields = this._getAllRelatedFields(assoc.remoteField);

          includes = {
            srcField: remoteField => {
              remoteField || (remoteField = entity.name);
              return _.isNil(remoteFields) || (Array.isArray(remoteFields) ? remoteFields.indexOf(remoteField) > -1 : remoteFields === remoteField);
            }
          };
        }

        let backRef = destEntity.getReferenceTo(entity.name, includes, excludes);

        if (backRef) {
          if (backRef.type === 'hasMany' || backRef.type === 'hasOne') {
            if (!assoc.by) {
              throw new Error('"m2n" association requires "by" property. Entity: ' + entity.name + ' destination: ' + destEntityName);
            }

            let connectedByParts = assoc.by.split('.');

            if (!(connectedByParts.length <= 2)) {
              throw new Error("Assertion failed: connectedByParts.length <= 2");
            }

            let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
            let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

            if (!connEntityName) {
              throw new Error("Assertion failed: connEntityName");
            }

            let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:${backRef.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;
            let tag2 = `${destEntityName}:${backRef.type === 'hasMany' ? 'm' : '1'}-${entity.name}:${assoc.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;

            if (assoc.srcField) {
              tag1 += ' ' + assoc.srcField;
            }

            if (backRef.srcField) {
              tag2 += ' ' + backRef.srcField;
            }

            if (this._processedRef.has(tag1) || this._processedRef.has(tag2)) {
              return;
            }

            let connectedByParts2 = backRef.by.split('.');
            let connectedByField2 = connectedByParts2.length > 1 && connectedByParts2[1] || destEntityNameAsFieldName;

            if (connectedByField === connectedByField2) {
              throw new Error('Cannot use the same "by" field in a relation entity.');
            }

            let connEntity = schema.ensureGetEntity(entity.oolModule, connEntityName, pendingEntities);

            if (!connEntity) {
              connEntity = this._addRelationEntity(schema, connEntityName, entity.name, destEntityName, connectedByField, connectedByField2);
              pendingEntities.push(connEntity.name);
              this.logger.log('debug', `New entity "${connEntity.name}" added by association.`);
            }

            this._updateRelationEntity(connEntity, entity, destEntity, entity.name, destEntityName, connectedByField, connectedByField2);

            let localFieldName = assoc.srcField || pluralize(destEntityNameAsFieldName);
            entity.addAssociation(localFieldName, {
              entity: connEntityName,
              key: connEntity.key,
              on: this._translateJoinCondition({ ...assocNames,
                [connEntityName]: localFieldName
              }, entity.key, localFieldName, assoc.with ? {
                by: connectedByField,
                with: assoc.with
              } : connectedByField),
              field: connectedByField,
              ...(assoc.type === 'hasMany' ? {
                list: true
              } : {}),
              assoc: connectedByField2
            });
            let remoteFieldName = backRef.srcField || pluralize(entity.name);
            destEntity.addAssociation(remoteFieldName, {
              entity: connEntityName,
              key: connEntity.key,
              on: this._translateJoinCondition({ ...assocNames,
                [connEntityName]: remoteFieldName
              }, destEntity.key, remoteFieldName, backRef.with ? {
                by: connectedByField2,
                with: backRef.with
              } : connectedByField2),
              field: connectedByField2,
              ...(backRef.type === 'hasMany' ? {
                list: true
              } : {}),
              assoc: connectedByField
            });

            this._processedRef.add(tag1);

            this.logger.log('verbose', `Processed 2-way reference: ${tag1}`);

            this._processedRef.add(tag2);

            this.logger.log('verbose', `Processed 2-way reference: ${tag2}`);
          } else if (backRef.type === 'belongsTo') {
            if (assoc.by) {
              throw new Error('todo: belongsTo by. entity: ' + entity.name);
            } else {
              let anchor = assoc.srcField || (assoc.type === 'hasMany' ? pluralize(destEntityNameAsFieldName) : destEntityNameAsFieldName);
              let remoteField = assoc.remoteField || backRef.srcField || entity.name;

              if (destEntity.hasFeature('logicalDeletion')) {
                let deletionCheck = {
                  oolType: 'BinaryExpression',
                  operator: '!=',
                  left: {
                    oolType: 'ObjectReference',
                    name: `${destEntityName}.${destEntity.features['logicalDeletion'].field}`
                  },
                  right: true
                };

                if (_.isPlainObject(remoteField)) {
                  remoteField.with = {
                    oolType: 'LogicalExpression',
                    operator: 'and',
                    left: remoteField.with,
                    right: deletionCheck
                  };
                } else if (assoc.with) {
                  assoc.with = {
                    oolType: 'LogicalExpression',
                    operator: 'and',
                    left: assoc.with,
                    right: deletionCheck
                  };
                } else {
                  assoc.with = deletionCheck;
                }
              }

              entity.addAssociation(anchor, {
                entity: destEntityName,
                key: destEntity.key,
                on: this._translateJoinCondition({ ...assocNames,
                  [destEntityName]: anchor
                }, entity.key, anchor, assoc.with ? {
                  by: remoteField,
                  with: assoc.with
                } : remoteField),
                ...(typeof remoteField === 'string' ? {
                  field: remoteField
                } : {}),
                ...(assoc.type === 'hasMany' ? {
                  list: true
                } : {})
              });
            }
          } else {
            throw new Error('Unexpected path. Entity: ' + entity.name + ', association: ' + JSON.stringify(assoc, null, 2));
          }
        } else {
          let connectedByParts = assoc.by ? assoc.by.split('.') : [OolUtils.prefixNaming(entity.name, destEntityName)];

          if (!(connectedByParts.length <= 2)) {
            throw new Error("Assertion failed: connectedByParts.length <= 2");
          }

          let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
          let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

          if (!connEntityName) {
            throw new Error("Assertion failed: connEntityName");
          }

          let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:* by ${connEntityName}`;

          if (assoc.srcField) {
            tag1 += ' ' + assoc.srcField;
          }

          if (!!this._processedRef.has(tag1)) {
            throw new Error("Assertion failed: !this._processedRef.has(tag1)");
          }

          let connEntity = schema.ensureGetEntity(entity.oolModule, connEntityName, pendingEntities);

          if (!connEntity) {
            connEntity = this._addRelationEntity(schema, connEntityName, entity.name, destEntityName, connectedByField, destEntityNameAsFieldName);
            pendingEntities.push(connEntity.name);
            this.logger.log('debug', `New entity "${connEntity.name}" added by association.`);
          }

          let connBackRef1 = connEntity.getReferenceTo(entity.name, {
            type: 'refersTo',
            srcField: f => _.isNil(f) || f == connectedByField
          });

          if (!connBackRef1) {
            throw new Error(`Cannot find back reference to "${entity.name}" from relation entity "${connEntityName}".`);
          }

          let connBackRef2 = connEntity.getReferenceTo(destEntityName, {
            type: 'refersTo'
          }, {
            association: connBackRef1
          });

          if (!connBackRef2) {
            throw new Error(`Cannot find back reference to "${destEntityName}" from relation entity "${connEntityName}".`);
          }

          let connectedByField2 = connBackRef2.srcField || destEntityNameAsFieldName;

          if (connectedByField === connectedByField2) {
            throw new Error('Cannot use the same "by" field in a relation entity. Detail: ' + JSON.stringify({
              src: entity.name,
              dest: destEntityName,
              srcField: assoc.srcField,
              by: connectedByField
            }));
          }

          this._updateRelationEntity(connEntity, entity, destEntity, entity.name, destEntityName, connectedByField, connectedByField2);

          let localFieldName = assoc.srcField || pluralize(destEntityNameAsFieldName);
          entity.addAssociation(localFieldName, {
            entity: connEntityName,
            key: connEntity.key,
            on: this._translateJoinCondition({ ...assocNames,
              [connEntityName]: localFieldName
            }, entity.key, localFieldName, assoc.with ? {
              by: connectedByField,
              with: assoc.with
            } : connectedByField),
            field: connectedByField,
            ...(assoc.type === 'hasMany' ? {
              list: true
            } : {}),
            assoc: connectedByField2
          });

          this._processedRef.add(tag1);

          this.logger.log('verbose', `Processed 1-way reference: ${tag1}`);
        }

        break;

      case 'refersTo':
      case 'belongsTo':
        let localField = assoc.srcField || destEntityNameAsFieldName;

        if (assoc.type === 'refersTo') {
          let tag = `${entity.name}:1-${destEntityName}:* ${localField}`;

          if (this._processedRef.has(tag)) {
            return;
          }

          this._processedRef.add(tag);

          this.logger.log('verbose', `Processed week reference: ${tag}`);
        }

        entity.addAssocField(localField, destEntity, destKeyField, assoc.fieldProps);
        entity.addAssociation(localField, {
          entity: destEntityName,
          key: destEntity.key,
          on: {
            [localField]: this._toColumnReference(localField + '.' + destEntity.key)
          }
        });
        let localFieldObj = entity.fields[localField];
        let constraints = {};

        if (localFieldObj.constraintOnUpdate) {
          constraints.onUpdate = localFieldObj.constraintOnUpdate;
        }

        if (localFieldObj.constraintOnDelete) {
          constraints.onDelete = localFieldObj.constraintOnDelete;
        }

        if (assoc.type === 'belongsTo') {
          constraints.onUpdate || (constraints.onUpdate = 'RESTRICT');
          constraints.onDelete || (constraints.onDelete = 'RESTRICT');
        } else if (localFieldObj.optional) {
          constraints.onUpdate || (constraints.onUpdate = 'SET NULL');
          constraints.onDelete || (constraints.onDelete = 'SET NULL');
        }

        constraints.onUpdate || (constraints.onUpdate = 'NO ACTION');
        constraints.onDelete || (constraints.onDelete = 'NO ACTION');

        this._addReference(entity.name, localField, destEntityName, destKeyField.name, constraints);

        break;
    }
  }

  _oolConditionToQueryCondition(context, oolCon) {
    if (!oolCon.oolType) {
      throw new Error("Assertion failed: oolCon.oolType");
    }

    if (oolCon.oolType === 'BinaryExpression') {
      if (oolCon.operator === '==') {
        let left = oolCon.left;

        if (left.oolType && left.oolType === 'ObjectReference') {
          left = this._translateReference(context, left.name, true);
        }

        let right = oolCon.right;

        if (right.oolType && right.oolType === 'ObjectReference') {
          right = this._translateReference(context, right.name);
        }

        return {
          [left]: {
            '$eq': right
          }
        };
      } else if (oolCon.operator === '!=') {
        let left = oolCon.left;

        if (left.oolType && left.oolType === 'ObjectReference') {
          left = this._translateReference(context, left.name, true);
        }

        let right = oolCon.right;

        if (right.oolType && right.oolType === 'ObjectReference') {
          right = this._translateReference(context, right.name);
        }

        return {
          [left]: {
            '$ne': right
          }
        };
      }
    } else if (oolCon.oolType === 'UnaryExpression') {
      let arg;

      switch (oolCon.operator) {
        case 'is-null':
          arg = oolCon.argument;

          if (arg.oolType && arg.oolType === 'ObjectReference') {
            arg = this._translateReference(context, arg.name, true);
          }

          return {
            [arg]: {
              '$eq': null
            }
          };

        case 'is-not-null':
          arg = oolCon.argument;

          if (arg.oolType && arg.oolType === 'ObjectReference') {
            arg = this._translateReference(context, arg.name, true);
          }

          return {
            [arg]: {
              '$ne': null
            }
          };

        default:
          throw new Error('Unknown UnaryExpression operator: ' + oolCon.operator);
      }
    } else if (oolCon.oolType === 'LogicalExpression') {
      switch (oolCon.operator) {
        case 'and':
          return {
            $and: [this._oolConditionToQueryCondition(context, oolCon.left), this._oolConditionToQueryCondition(context, oolCon.right)]
          };

        case 'or':
          return {
            $or: [this._oolConditionToQueryCondition(context, oolCon.left), this._oolConditionToQueryCondition(context, oolCon.right)]
          };
      }
    }

    throw new Error('Unknown syntax: ' + JSON.stringify(oolCon));
  }

  _translateReference(context, ref, asKey) {
    let [base, ...other] = ref.split('.');
    let translated = context[base];

    if (!translated) {
      throw new Error(`Referenced object "${ref}" not found in context.`);
    }

    let refName = [translated, ...other].join('.');

    if (asKey) {
      return refName;
    }

    return this._toColumnReference(refName);
  }

  _addReference(left, leftField, right, rightField, constraints) {
    if (Array.isArray(leftField)) {
      leftField.forEach(lf => this._addReference(left, lf, right, rightField, constraints));
      return;
    }

    if (_.isPlainObject(leftField)) {
      this._addReference(left, leftField.by, right.rightField, constraints);

      return;
    }

    if (!(typeof leftField === 'string')) {
      throw new Error("Assertion failed: typeof leftField === 'string'");
    }

    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      refs4LeftEntity = [];
      this._references[left] = refs4LeftEntity;
    } else {
      let found = _.find(refs4LeftEntity, item => item.leftField === leftField && item.right === right && item.rightField === rightField);

      if (found) return;
    }

    refs4LeftEntity.push({
      leftField,
      right,
      rightField,
      constraints
    });
  }

  _getReferenceOfField(left, leftField) {
    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      return undefined;
    }

    let reference = _.find(refs4LeftEntity, item => item.leftField === leftField);

    if (!reference) {
      return undefined;
    }

    return reference;
  }

  _hasReferenceOfField(left, leftField) {
    let refs4LeftEntity = this._references[left];
    if (!refs4LeftEntity) return false;
    return undefined !== _.find(refs4LeftEntity, item => item.leftField === leftField);
  }

  _getReferenceBetween(left, right) {
    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      return undefined;
    }

    let reference = _.find(refs4LeftEntity, item => item.right === right);

    if (!reference) {
      return undefined;
    }

    return reference;
  }

  _hasReferenceBetween(left, right) {
    let refs4LeftEntity = this._references[left];
    if (!refs4LeftEntity) return false;
    return undefined !== _.find(refs4LeftEntity, item => item.right === right);
  }

  _featureReducer(schema, entity, featureName, feature) {
    let field;

    switch (featureName) {
      case 'autoId':
        field = entity.fields[feature.field];

        if (field.type === 'integer' && !field.generator) {
          field.autoIncrementId = true;

          if ('startFrom' in feature) {
            this._events.on('setTableOptions:' + entity.name, extraOpts => {
              extraOpts['AUTO_INCREMENT'] = feature.startFrom;
            });
          }
        }

        break;

      case 'createTimestamp':
        field = entity.fields[feature.field];
        field.isCreateTimestamp = true;
        break;

      case 'updateTimestamp':
        field = entity.fields[feature.field];
        field.isUpdateTimestamp = true;
        break;

      case 'logicalDeletion':
        break;

      case 'atLeastOneNotNull':
        break;

      case 'validateAllFieldsOnCreation':
        break;

      case 'stateTracking':
        break;

      case 'i18n':
        break;

      case 'changeLog':
        let changeLogSettings = Util.getValueByPath(schema.deploymentSettings, 'features.changeLog');

        if (!changeLogSettings) {
          throw new Error(`Missing "changeLog" feature settings in deployment config for schema [${schema.name}].`);
        }

        if (!changeLogSettings.dataSource) {
          throw new Error(`"changeLog.dataSource" is required. Schema: ${schema.name}`);
        }

        Object.assign(feature, changeLogSettings);
        break;

      default:
        throw new Error('Unsupported feature "' + featureName + '".');
    }
  }

  _writeFile(filePath, content) {
    fs.ensureFileSync(filePath);
    fs.writeFileSync(filePath, content);
    this.logger.log('info', 'Generated db script: ' + filePath);
  }

  _addRelationEntity(schema, relationEntityName, entity1Name, entity2Name, entity1RefField, entity2RefField) {
    let entityInfo = {
      features: ['autoId', 'createTimestamp'],
      indexes: [{
        "fields": [entity1RefField, entity2RefField],
        "unique": true
      }],
      associations: [{
        "type": "refersTo",
        "destEntity": entity1Name,
        "srcField": entity1RefField
      }, {
        "type": "refersTo",
        "destEntity": entity2Name,
        "srcField": entity2RefField
      }]
    };
    let entity = new Entity(this.linker, relationEntityName, schema.oolModule, entityInfo);
    entity.link();
    schema.addEntity(entity);
    return entity;
  }

  _updateRelationEntity(relationEntity, entity1, entity2, entity1Name, entity2Name, connectedByField, connectedByField2) {
    let relationEntityName = relationEntity.name;
    this._relationEntities[relationEntityName] = true;

    if (relationEntity.info.associations) {
      let hasRefToEntity1 = false,
          hasRefToEntity2 = false;

      _.each(relationEntity.info.associations, assoc => {
        if (assoc.type === 'refersTo' && assoc.destEntity === entity1Name && (assoc.srcField || entity1Name) === connectedByField) {
          hasRefToEntity1 = true;
        }

        if (assoc.type === 'refersTo' && assoc.destEntity === entity2Name && (assoc.srcField || entity2Name) === connectedByField2) {
          hasRefToEntity2 = true;
        }
      });

      if (hasRefToEntity1 && hasRefToEntity2) {
        return;
      }
    }

    let tag1 = `${relationEntityName}:1-${entity1Name}:* ${connectedByField}`;
    let tag2 = `${relationEntityName}:1-${entity2Name}:* ${connectedByField2}`;

    if (this._processedRef.has(tag1)) {
      if (!this._processedRef.has(tag2)) {
        throw new Error("Assertion failed: this._processedRef.has(tag2)");
      }

      return;
    }

    this._processedRef.add(tag1);

    this.logger.log('verbose', `Processed bridging reference: ${tag1}`);

    this._processedRef.add(tag2);

    this.logger.log('verbose', `Processed bridging reference: ${tag2}`);
    let keyEntity1 = entity1.getKeyField();

    if (Array.isArray(keyEntity1)) {
      throw new Error(`Combination primary key is not supported. Entity: ${entity1Name}`);
    }

    let keyEntity2 = entity2.getKeyField();

    if (Array.isArray(keyEntity2)) {
      throw new Error(`Combination primary key is not supported. Entity: ${entity2Name}`);
    }

    relationEntity.addAssocField(connectedByField, entity1, keyEntity1);
    relationEntity.addAssocField(connectedByField2, entity2, keyEntity2);
    relationEntity.addAssociation(connectedByField, {
      entity: entity1Name
    });
    relationEntity.addAssociation(connectedByField2, {
      entity: entity2Name
    });
    let allCascade = {
      onUpdate: 'RESTRICT',
      onDelete: 'RESTRICT'
    };

    this._addReference(relationEntityName, connectedByField, entity1Name, keyEntity1.name, allCascade);

    this._addReference(relationEntityName, connectedByField2, entity2Name, keyEntity2.name, allCascade);
  }

  static oolOpToSql(op) {
    switch (op) {
      case '=':
        return '=';

      default:
        throw new Error('oolOpToSql to be implemented.');
    }
  }

  static oolToSql(schema, doc, ool, params) {
    if (!ool.oolType) {
      return ool;
    }

    switch (ool.oolType) {
      case 'BinaryExpression':
        let left, right;

        if (ool.left.oolType) {
          left = MySQLModeler.oolToSql(schema, doc, ool.left, params);
        } else {
          left = ool.left;
        }

        if (ool.right.oolType) {
          right = MySQLModeler.oolToSql(schema, doc, ool.right, params);
        } else {
          right = ool.right;
        }

        return left + ' ' + MySQLModeler.oolOpToSql(ool.operator) + ' ' + right;

      case 'ObjectReference':
        if (!OolUtils.isMemberAccess(ool.name)) {
          if (params && _.find(params, p => p.name === ool.name) !== -1) {
            return 'p' + _.upperFirst(ool.name);
          }

          throw new Error(`Referencing to a non-existing param "${ool.name}".`);
        }

        let {
          entityNode,
          entity,
          field
        } = OolUtils.parseReferenceInDocument(schema, doc, ool.name);
        return entityNode.alias + '.' + MySQLModeler.quoteIdentifier(field.name);

      default:
        throw new Error('oolToSql to be implemented.');
    }
  }

  static _orderByToSql(schema, doc, ool) {
    return MySQLModeler.oolToSql(schema, doc, {
      oolType: 'ObjectReference',
      name: ool.field
    }) + (ool.ascend ? '' : ' DESC');
  }

  _viewDocumentToSQL(modelingSchema, view) {
    let sql = '  ';

    let doc = _.cloneDeep(view.getDocumentHierarchy(modelingSchema));

    let [colList, alias, joins] = this._buildViewSelect(modelingSchema, doc, 0);

    sql += 'SELECT ' + colList.join(', ') + ' FROM ' + MySQLModeler.quoteIdentifier(doc.entity) + ' AS ' + alias;

    if (!_.isEmpty(joins)) {
      sql += ' ' + joins.join(' ');
    }

    if (!_.isEmpty(view.selectBy)) {
      sql += ' WHERE ' + view.selectBy.map(select => MySQLModeler.oolToSql(modelingSchema, doc, select, view.params)).join(' AND ');
    }

    if (!_.isEmpty(view.groupBy)) {
      sql += ' GROUP BY ' + view.groupBy.map(col => MySQLModeler._orderByToSql(modelingSchema, doc, col)).join(', ');
    }

    if (!_.isEmpty(view.orderBy)) {
      sql += ' ORDER BY ' + view.orderBy.map(col => MySQLModeler._orderByToSql(modelingSchema, doc, col)).join(', ');
    }

    let skip = view.skip || 0;

    if (view.limit) {
      sql += ' LIMIT ' + MySQLModeler.oolToSql(modelingSchema, doc, skip, view.params) + ', ' + MySQLModeler.oolToSql(modelingSchema, doc, view.limit, view.params);
    } else if (view.skip) {
      sql += ' OFFSET ' + MySQLModeler.oolToSql(modelingSchema, doc, view.skip, view.params);
    }

    return sql;
  }

  _createTableStatement(entityName, entity) {
    let sql = 'CREATE TABLE IF NOT EXISTS `' + entityName + '` (\n';

    _.each(entity.fields, (field, name) => {
      sql += '  ' + MySQLModeler.quoteIdentifier(name) + ' ' + MySQLModeler.columnDefinition(field) + ',\n';
    });

    sql += '  PRIMARY KEY (' + MySQLModeler.quoteListOrValue(entity.key) + '),\n';

    if (entity.indexes && entity.indexes.length > 0) {
      entity.indexes.forEach(index => {
        sql += '  ';

        if (index.unique) {
          sql += 'UNIQUE ';
        }

        sql += 'KEY (' + MySQLModeler.quoteListOrValue(index.fields) + '),\n';
      });
    }

    let lines = [];

    this._events.emit('beforeEndColumnDefinition:' + entityName, lines);

    if (lines.length > 0) {
      sql += '  ' + lines.join(',\n  ');
    } else {
      sql = sql.substr(0, sql.length - 2);
    }

    sql += '\n)';
    let extraProps = {};

    this._events.emit('setTableOptions:' + entityName, extraProps);

    let props = Object.assign({}, this._dbOptions.table, extraProps);
    sql = _.reduce(props, function (result, value, key) {
      return result + ' ' + key + '=' + value;
    }, sql);
    sql += ';\n';
    return sql;
  }

  _addForeignKeyStatement(entityName, relation, schemaToConnector) {
    let refTable = relation.right;

    if (refTable.indexOf('.') > 0) {
      let [schemaName, refEntityName] = refTable.split('.');
      let targetConnector = schemaToConnector[schemaName];

      if (!targetConnector) {
        throw new Error("Assertion failed: targetConnector");
      }

      refTable = targetConnector.database + '`.`' + refEntityName;
    }

    let sql = 'ALTER TABLE `' + entityName + '` ADD FOREIGN KEY (`' + relation.leftField + '`) ' + 'REFERENCES `' + refTable + '` (`' + relation.rightField + '`) ';
    sql += `ON UPDATE ${relation.constraints.onUpdate} ON DELETE ${relation.constraints.onDelete};\n`;
    return sql;
  }

  static foreignKeyFieldNaming(entityName, entity) {
    let leftPart = Util._.camelCase(entityName);

    let rightPart = Util.pascalCase(entity.key);

    if (_.endsWith(leftPart, rightPart)) {
      return leftPart;
    }

    return leftPart + rightPart;
  }

  static quoteString(str) {
    return "'" + str.replace(/'/g, "\\'") + "'";
  }

  static quoteIdentifier(str) {
    return "`" + str + "`";
  }

  static quoteListOrValue(obj) {
    return _.isArray(obj) ? obj.map(v => MySQLModeler.quoteIdentifier(v)).join(', ') : MySQLModeler.quoteIdentifier(obj);
  }

  static complianceCheck(entity) {
    let result = {
      errors: [],
      warnings: []
    };

    if (!entity.key) {
      result.errors.push('Primary key is not specified.');
    }

    return result;
  }

  static columnDefinition(field, isProc) {
    let col;

    switch (field.type) {
      case 'integer':
        col = MySQLModeler.intColumnDefinition(field);
        break;

      case 'number':
        col = MySQLModeler.floatColumnDefinition(field);
        break;

      case 'text':
        col = MySQLModeler.textColumnDefinition(field);
        break;

      case 'boolean':
        col = MySQLModeler.boolColumnDefinition(field);
        break;

      case 'binary':
        col = MySQLModeler.binaryColumnDefinition(field);
        break;

      case 'datetime':
        col = MySQLModeler.datetimeColumnDefinition(field);
        break;

      case 'object':
        col = MySQLModeler.textColumnDefinition(field);
        break;

      case 'enum':
        col = MySQLModeler.enumColumnDefinition(field);
        break;

      case 'array':
        col = MySQLModeler.textColumnDefinition(field);
        break;

      default:
        throw new Error('Unsupported type "' + field.type + '".');
    }

    let {
      sql,
      type
    } = col;

    if (!isProc) {
      sql += this.columnNullable(field);
      sql += this.defaultValue(field, type);
    }

    return sql;
  }

  static intColumnDefinition(info) {
    let sql, type;

    if (info.digits) {
      if (info.digits > 10) {
        type = sql = 'BIGINT';
      } else if (info.digits > 7) {
        type = sql = 'INT';
      } else if (info.digits > 4) {
        type = sql = 'MEDIUMINT';
      } else if (info.digits > 2) {
        type = sql = 'SMALLINT';
      } else {
        type = sql = 'TINYINT';
      }

      sql += `(${info.digits})`;
    } else {
      type = sql = 'INT';
    }

    if (info.unsigned) {
      sql += ' UNSIGNED';
    }

    return {
      sql,
      type
    };
  }

  static floatColumnDefinition(info) {
    let sql = '',
        type;

    if (info.type == 'number' && info.exact) {
      type = sql = 'DECIMAL';

      if (info.totalDigits > 65) {
        throw new Error('Total digits exceed maximum limit.');
      }
    } else {
      if (info.totalDigits > 23) {
        type = sql = 'DOUBLE';

        if (info.totalDigits > 53) {
          throw new Error('Total digits exceed maximum limit.');
        }
      } else {
        type = sql = 'FLOAT';
      }
    }

    if ('totalDigits' in info) {
      sql += '(' + info.totalDigits;

      if ('decimalDigits' in info) {
        sql += ', ' + info.decimalDigits;
      }

      sql += ')';
    } else {
      if ('decimalDigits' in info) {
        if (info.decimalDigits > 23) {
          sql += '(53, ' + info.decimalDigits + ')';
        } else {
          sql += '(23, ' + info.decimalDigits + ')';
        }
      }
    }

    return {
      sql,
      type
    };
  }

  static textColumnDefinition(info) {
    let sql = '',
        type;

    if (info.fixedLength && info.fixedLength <= 255) {
      sql = 'CHAR(' + info.fixedLength + ')';
      type = 'CHAR';
    } else if (info.maxLength) {
      if (info.maxLength > 16777215) {
        type = sql = 'LONGTEXT';
      } else if (info.maxLength > 65535) {
        type = sql = 'MEDIUMTEXT';
      } else if (info.maxLength > 2000) {
        type = sql = 'TEXT';
      } else {
        type = sql = 'VARCHAR';

        if (info.fixedLength) {
          sql += '(' + info.fixedLength + ')';
        } else {
          sql += '(' + info.maxLength + ')';
        }
      }
    } else {
      type = sql = 'TEXT';
    }

    return {
      sql,
      type
    };
  }

  static binaryColumnDefinition(info) {
    let sql = '',
        type;

    if (info.fixedLength <= 255) {
      sql = 'BINARY(' + info.fixedLength + ')';
      type = 'BINARY';
    } else if (info.maxLength) {
      if (info.maxLength > 16777215) {
        type = sql = 'LONGBLOB';
      } else if (info.maxLength > 65535) {
        type = sql = 'MEDIUMBLOB';
      } else {
        type = sql = 'VARBINARY';

        if (info.fixedLength) {
          sql += '(' + info.fixedLength + ')';
        } else {
          sql += '(' + info.maxLength + ')';
        }
      }
    } else {
      type = sql = 'BLOB';
    }

    return {
      sql,
      type
    };
  }

  static boolColumnDefinition() {
    return {
      sql: 'TINYINT(1)',
      type: 'TINYINT'
    };
  }

  static datetimeColumnDefinition(info) {
    let sql;

    if (!info.range || info.range === 'datetime') {
      sql = 'DATETIME';
    } else if (info.range === 'date') {
      sql = 'DATE';
    } else if (info.range === 'time') {
      sql = 'TIME';
    } else if (info.range === 'year') {
      sql = 'YEAR';
    } else if (info.range === 'timestamp') {
      sql = 'TIMESTAMP';
    }

    return {
      sql,
      type: sql
    };
  }

  static enumColumnDefinition(info) {
    return {
      sql: 'ENUM(' + _.map(info.values, v => MySQLModeler.quoteString(v)).join(', ') + ')',
      type: 'ENUM'
    };
  }

  static columnNullable(info) {
    if (info.hasOwnProperty('optional') && info.optional) {
      return ' NULL';
    }

    return ' NOT NULL';
  }

  static defaultValue(info, type) {
    if (info.isCreateTimestamp) {
      info.createByDb = true;
      return ' DEFAULT CURRENT_TIMESTAMP';
    }

    if (info.autoIncrementId) {
      info.createByDb = true;
      return ' AUTO_INCREMENT';
    }

    if (info.isUpdateTimestamp) {
      info.updateByDb = true;
      return ' ON UPDATE CURRENT_TIMESTAMP';
    }

    let sql = '';

    if (!info.optional) {
      if (info.hasOwnProperty('default')) {
        let defaultValue = info['default'];

        if (info.type === 'boolean') {
          sql += ' DEFAULT ' + (Types.BOOLEAN.sanitize(defaultValue) ? '1' : '0');
        }
      } else if (!info.hasOwnProperty('auto')) {
        if (UNSUPPORTED_DEFAULT_VALUE.has(type)) {
          return '';
        }

        if (info.type === 'boolean' || info.type === 'integer' || info.type === 'number') {
          sql += ' DEFAULT 0';
        } else if (info.type === 'datetime') {
          sql += ' DEFAULT CURRENT_TIMESTAMP';
        } else if (info.type === 'enum') {
          sql += ' DEFAULT ' + quote(info.values[0]);
        } else {
          sql += ' DEFAULT ""';
        }

        info.createByDb = true;
      }
    }

    return sql;
  }

  static removeTableNamePrefix(entityName, removeTablePrefix) {
    if (removeTablePrefix) {
      entityName = _.trim(_.snakeCase(entityName));
      removeTablePrefix = _.trimEnd(_.snakeCase(removeTablePrefix), '_') + '_';

      if (_.startsWith(entityName, removeTablePrefix)) {
        entityName = entityName.substr(removeTablePrefix.length);
      }
    }

    return OolUtils.entityNaming(entityName);
  }

}

module.exports = MySQLModeler;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJwdXRJbnRvQnVja2V0IiwiT29sVXRpbHMiLCJwbHVyYWxpemUiLCJpc0RvdFNlcGFyYXRlTmFtZSIsImV4dHJhY3REb3RTZXBhcmF0ZU5hbWUiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJzY2hlbWFUb0Nvbm5lY3RvciIsImxvZyIsIm5hbWUiLCJtb2RlbGluZ1NjaGVtYSIsImNsb25lIiwicGVuZGluZ0VudGl0aWVzIiwiT2JqZWN0Iiwia2V5cyIsImVudGl0aWVzIiwibGVuZ3RoIiwiZW50aXR5TmFtZSIsInNoaWZ0IiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJhc3NvY3MiLCJfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyIsImFzc29jTmFtZXMiLCJyZWR1Y2UiLCJyZXN1bHQiLCJ2IiwiZm9yRWFjaCIsImFzc29jIiwiX3Byb2Nlc3NBc3NvY2lhdGlvbiIsImVtaXQiLCJzcWxGaWxlc0RpciIsImpvaW4iLCJkYXRhYmFzZSIsImRiRmlsZVBhdGgiLCJma0ZpbGVQYXRoIiwidGFibGVTUUwiLCJyZWxhdGlvblNRTCIsImRhdGEiLCJlYWNoIiwiYWRkSW5kZXhlcyIsImNvbXBsaWFuY2VDaGVjayIsImVycm9ycyIsIm1lc3NhZ2UiLCJ3YXJuaW5ncyIsIkVycm9yIiwiZmVhdHVyZXMiLCJmb3JPd24iLCJmIiwiZmVhdHVyZU5hbWUiLCJBcnJheSIsImlzQXJyYXkiLCJmZiIsIl9mZWF0dXJlUmVkdWNlciIsIl9jcmVhdGVUYWJsZVN0YXRlbWVudCIsImRhdGFTZXQiLCJydW50aW1lRW52IiwicmVjb3JkcyIsImVudGl0eURhdGEiLCJyZWNvcmQiLCJpc1BsYWluT2JqZWN0IiwiZmllbGRzIiwia2V5RmllbGQiLCJhdXRvIiwiZGVmYXVsdEJ5RGIiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsIm9vbE1vZHVsZSIsInB1c2giLCJhc3NpZ24iLCJub2RlcyIsInJlZnMiLCJzcmNFbnRpdHlOYW1lIiwicmVmIiwiX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQiLCJfd3JpdGVGaWxlIiwiaW5pdElkeEZpbGVzIiwiZW52RGF0YSIsImVudGl0aWVzRGF0YSIsImluaXRGaWxlTmFtZSIsInBhdGhOb2RlcyIsImluaXRGaWxlUGF0aCIsImlkeEZpbGVQYXRoIiwiSlNPTiIsInN0cmluZ2lmeSIsImNvbnNvbGUiLCJkaXIiLCJkZXB0aCIsImxpc3QiLCJmaWxlUGF0aCIsIm1hbnVhbCIsImV4aXN0c1N5bmMiLCJsaW5lcyIsInJlYWRGaWxlU3luYyIsInNwbGl0IiwibGluZSIsInN0YXJ0c1dpdGgiLCJjb25jYXQiLCJmdW5jU1FMIiwic3BGaWxlUGF0aCIsIl90b0NvbHVtblJlZmVyZW5jZSIsIm9vclR5cGUiLCJfdHJhbnNsYXRlSm9pbkNvbmRpdGlvbiIsImxvY2FsRmllbGQiLCJhbmNob3IiLCJyZW1vdGVGaWVsZCIsIm1hcCIsInJmIiwicmV0IiwiYnkiLCJ3aXRoRXh0cmEiLCJfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbiIsIndpdGgiLCIkYW5kIiwiX2dldEFsbFJlbGF0ZWRGaWVsZHMiLCJ1bmRlZmluZWQiLCJzcmNGaWVsZCIsInR5cGUiLCJkZXN0RW50aXR5IiwiZW50aXR5S2V5RmllbGQiLCJnZXRLZXlGaWVsZCIsImRlc3RFbnRpdHlOYW1lIiwiZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSIsImRlc3RTY2hlbWFOYW1lIiwiYWN0dWFsRGVzdEVudGl0eU5hbWUiLCJkZXN0U2NoZW1hIiwic2NoZW1hcyIsImxpbmtlZCIsImVuc3VyZUdldEVudGl0eSIsImRlc3RLZXlGaWVsZCIsImluY2x1ZGVzIiwiZXhjbHVkZXMiLCJ0eXBlcyIsImFzc29jaWF0aW9uIiwiY2IiLCJyZW1vdGVGaWVsZHMiLCJpc05pbCIsImluZGV4T2YiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvbiIsImZpZWxkIiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwiaGFzRmVhdHVyZSIsImRlbGV0aW9uQ2hlY2siLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwicmlnaHQiLCJwcmVmaXhOYW1pbmciLCJjb25uQmFja1JlZjEiLCJjb25uQmFja1JlZjIiLCJzcmMiLCJkZXN0IiwidGFnIiwiYWRkQXNzb2NGaWVsZCIsImZpZWxkUHJvcHMiLCJsb2NhbEZpZWxkT2JqIiwiY29uc3RyYWludHMiLCJjb25zdHJhaW50T25VcGRhdGUiLCJvblVwZGF0ZSIsImNvbnN0cmFpbnRPbkRlbGV0ZSIsIm9uRGVsZXRlIiwib3B0aW9uYWwiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsImFyZyIsImFyZ3VtZW50IiwiJG9yIiwiYXNLZXkiLCJiYXNlIiwib3RoZXIiLCJ0cmFuc2xhdGVkIiwicmVmTmFtZSIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJsZiIsInJlZnM0TGVmdEVudGl0eSIsImZvdW5kIiwiZmluZCIsIml0ZW0iLCJfZ2V0UmVmZXJlbmNlT2ZGaWVsZCIsInJlZmVyZW5jZSIsIl9oYXNSZWZlcmVuY2VPZkZpZWxkIiwiX2dldFJlZmVyZW5jZUJldHdlZW4iLCJfaGFzUmVmZXJlbmNlQmV0d2VlbiIsImZlYXR1cmUiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiY2hhbmdlTG9nU2V0dGluZ3MiLCJnZXRWYWx1ZUJ5UGF0aCIsImRlcGxveW1lbnRTZXR0aW5ncyIsImRhdGFTb3VyY2UiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwicmVsYXRpb25FbnRpdHlOYW1lIiwiZW50aXR5MU5hbWUiLCJlbnRpdHkyTmFtZSIsImVudGl0eTFSZWZGaWVsZCIsImVudGl0eTJSZWZGaWVsZCIsImVudGl0eUluZm8iLCJpbmRleGVzIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsImFsbENhc2NhZGUiLCJvb2xPcFRvU3FsIiwib3AiLCJvb2xUb1NxbCIsImRvYyIsIm9vbCIsInBhcmFtcyIsImlzTWVtYmVyQWNjZXNzIiwicCIsInVwcGVyRmlyc3QiLCJlbnRpdHlOb2RlIiwicGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50IiwiYWxpYXMiLCJxdW90ZUlkZW50aWZpZXIiLCJfb3JkZXJCeVRvU3FsIiwiYXNjZW5kIiwiX3ZpZXdEb2N1bWVudFRvU1FMIiwidmlldyIsInNxbCIsImNsb25lRGVlcCIsImdldERvY3VtZW50SGllcmFyY2h5IiwiY29sTGlzdCIsImpvaW5zIiwiX2J1aWxkVmlld1NlbGVjdCIsInNlbGVjdEJ5Iiwic2VsZWN0IiwiZ3JvdXBCeSIsImNvbCIsIm9yZGVyQnkiLCJza2lwIiwibGltaXQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4IiwidW5pcXVlIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVsYXRpb24iLCJyZWZUYWJsZSIsInNjaGVtYU5hbWUiLCJyZWZFbnRpdHlOYW1lIiwidGFyZ2V0Q29ubmVjdG9yIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJ2YWx1ZXMiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVuZCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEs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LFVBQUlsVixDQUFDLENBQUM0SCxVQUFGLENBQWFoRixVQUFiLEVBQXlCc1MsaUJBQXpCLENBQUosRUFBaUQ7QUFDN0N0UyxRQUFBQSxVQUFVLEdBQUdBLFVBQVUsQ0FBQzJQLE1BQVgsQ0FBa0IyQyxpQkFBaUIsQ0FBQ3ZTLE1BQXBDLENBQWI7QUFDSDtBQUNKOztBQUVELFdBQU92QyxRQUFRLENBQUN1SyxZQUFULENBQXNCL0gsVUFBdEIsQ0FBUDtBQUNIOztBQW5pRGM7O0FBc2lEbkIwUyxNQUFNLENBQUNDLE9BQVAsR0FBaUIzVSxZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcywgcXVvdGUsIHB1dEludG9CdWNrZXQgfSA9IFV0aWw7XG5cbmNvbnN0IE9vbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgeyBwbHVyYWxpemUsIGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lIH0gPSBPb2xVdGlscztcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7TG9nZ2VyfSBjb250ZXh0LmxvZ2dlciAtIExvZ2dlciBvYmplY3QgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSwgc2NoZW1hVG9Db25uZWN0b3IpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgbGV0IG1vZGVsaW5nU2NoZW1hID0gc2NoZW1hLmNsb25lKCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsICdCdWlsZGluZyByZWxhdGlvbnMuLi4nKTtcblxuICAgICAgICBsZXQgcGVuZGluZ0VudGl0aWVzID0gT2JqZWN0LmtleXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIHdoaWxlIChwZW5kaW5nRW50aXRpZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGV0IGVudGl0eU5hbWUgPSBwZW5kaW5nRW50aXRpZXMuc2hpZnQoKTtcbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBtb2RlbGluZ1NjaGVtYS5lbnRpdGllc1tlbnRpdHlOYW1lXTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkgeyAgXG4gICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIGFzc29jaWF0aW9ucyBvZiBlbnRpdHkgXCIke2VudGl0eU5hbWV9XCIuLi5gKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NzID0gdGhpcy5fcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jTmFtZXMgPSBhc3NvY3MucmVkdWNlKChyZXN1bHQsIHYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W3ZdID0gdjtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICB9LCB7fSk7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzLCBwZW5kaW5nRW50aXRpZXMpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzICAgICAgICBcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgLy9sZXQgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgYXNzZXJ0OiBlbnRpdHlOYW1lID09PSBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgIC8vbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZVtlbnRpdHlOYW1lXSA9IGVudGl0eS5jb2RlO1xuXG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSArICdcXG4nO1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaCgoeyBkYXRhU2V0LCBydW50aW1lRW52LCByZWNvcmRzIH0pID0+IHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgZW50aXR5RGF0YSA9IFtdO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlY29yZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRzLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQga2V5RmllbGQgPSBlbnRpdHkuZmllbGRzW2ZpZWxkc1swXV07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFrZXlGaWVsZC5hdXRvICYmICFrZXlGaWVsZC5kZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUga2V5IGZpZWxkIFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbm8gZGVmYXVsdCB2YWx1ZSBvciBhdXRvLWdlbmVyYXRlZCB2YWx1ZS5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHsgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBfLmZvck93bihyZWNvcmRzLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKX07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ0lOU0VSVCBJTlRPIGAnICsgZW50aXR5TmFtZSArICdgIFNFVCAnICsgXy5tYXAocmVjb3JkLCAodixrKSA9PiAnYCcgKyBrICsgJ2AgPSAnICsgSlNPTi5zdHJpbmdpZnkodikpLmpvaW4oJywgJykgKyAnO1xcbic7XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eURhdGEpKSB7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFTZXQgfHwgKGRhdGFTZXQgPSAnX2luaXQnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJ1bnRpbWVFbnYgfHwgKHJ1bnRpbWVFbnYgPSAnZGVmYXVsdCcpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbm9kZXMgPSBbIGRhdGFTZXQsIHJ1bnRpbWVFbnYgXTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZXMucHVzaChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGtleSA9IG5vZGVzLmpvaW4oJy4nKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgcHV0SW50b0J1Y2tldChkYXRhLCBrZXksIGVudGl0eURhdGEsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ1xcbic7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmVhY2gocmVmcywgcmVmID0+IHtcbiAgICAgICAgICAgICAgICByZWxhdGlvblNRTCArPSB0aGlzLl9hZGRGb3JlaWduS2V5U3RhdGVtZW50KHNyY0VudGl0eU5hbWUsIHJlZiwgc2NoZW1hVG9Db25uZWN0b3IvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSArICdcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBkYkZpbGVQYXRoKSwgdGFibGVTUUwpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICBsZXQgaW5pdElkeEZpbGVzID0ge307XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZGF0YSkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIF8uZm9yT3duKGRhdGEsIChlbnZEYXRhLCBkYXRhU2V0KSA9PiB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW52RGF0YSwgKGVudGl0aWVzRGF0YSwgcnVudGltZUVudikgPT4ge1xuICAgICAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdGllc0RhdGEsIChyZWNvcmRzLCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgaW5pdEZpbGVOYW1lID0gYDAtJHtlbnRpdHlOYW1lfS5qc29uYDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHBhdGhOb2RlcyA9IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWxGaWxlc0RpciwgJ2RhdGEnLCBkYXRhU2V0IHx8ICdfaW5pdCdcbiAgICAgICAgICAgICAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChydW50aW1lRW52ICE9PSAnZGVmYXVsdCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXRoTm9kZXMucHVzaChydW50aW1lRW52KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbiguLi5wYXRoTm9kZXMsIGluaXRGaWxlTmFtZSk7ICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGlkeEZpbGVQYXRoID0gcGF0aC5qb2luKC4uLnBhdGhOb2RlcywgJ2luZGV4Lmxpc3QnKTsgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGluaXRJZHhGaWxlcywgW2lkeEZpbGVQYXRoXSwgaW5pdEZpbGVOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRGaWxlUGF0aCksIEpTT04uc3RyaW5naWZ5KHsgW2VudGl0eU5hbWVdOiByZWNvcmRzIH0sIG51bGwsIDQpKTtcbiAgICAgICAgICAgICAgICAgICAgfSkgXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KVxuICAgICAgICB9IFxuXG4gICAgICAgIGNvbnNvbGUuZGlyKGluaXRJZHhGaWxlcywge2RlcHRoOiAxMH0pO1xuXG4gICAgICAgIF8uZm9yT3duKGluaXRJZHhGaWxlcywgKGxpc3QsIGZpbGVQYXRoKSA9PiB7XG4gICAgICAgICAgICBsZXQgaWR4RmlsZVBhdGggPSBwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBmaWxlUGF0aCk7XG5cbiAgICAgICAgICAgIGxldCBtYW51YWwgPSBbXTtcblxuICAgICAgICAgICAgaWYgKGZzLmV4aXN0c1N5bmMoaWR4RmlsZVBhdGgpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxpbmVzID0gZnMucmVhZEZpbGVTeW5jKGlkeEZpbGVQYXRoLCAndXRmOCcpLnNwbGl0KCdcXG4nKTtcbiAgICAgICAgICAgICAgICBsaW5lcy5mb3JFYWNoKGxpbmUgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWxpbmUuc3RhcnRzV2l0aCgnMC0nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbWFudWFsLnB1c2gobGluZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUoaWR4RmlsZVBhdGgsIGxpc3QuY29uY2F0KG1hbnVhbCkuam9pbignXFxuJykpO1xuICAgICAgICB9KTtcblxuICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICBcbiAgICAgICAgLy9wcm9jZXNzIHZpZXdcbiAgICAgICAgLypcbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHZpZXcuaW5mZXJUeXBlSW5mbyhtb2RlbGluZ1NjaGVtYSk7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcucGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1TUUxzLnB1c2goYHAke18udXBwZXJGaXJzdChwYXJhbS5uYW1lKX0gJHtNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihwYXJhbSwgdHJ1ZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9ICdcXG5FTkQ7XFxuXFxuJztcbiAgICAgICAgfSk7XG4gICAgICAgICovXG5cbiAgICAgICAgbGV0IHNwRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdwcm9jZWR1cmVzLnNxbCcpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuXG4gICAgICAgIHJldHVybiBtb2RlbGluZ1NjaGVtYTtcbiAgICB9ICAgIFxuXG4gICAgX3RvQ29sdW1uUmVmZXJlbmNlKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIHsgb29yVHlwZTogJ0NvbHVtblJlZmVyZW5jZScsIG5hbWUgfTsgIFxuICAgIH1cblxuICAgIF90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQuYnkpIH07XG4gICAgICAgICAgICBsZXQgd2l0aEV4dHJhID0gdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCByZW1vdGVGaWVsZC53aXRoKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGxvY2FsRmllbGQgaW4gd2l0aEV4dHJhKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJGFuZDogWyByZXQsIHdpdGhFeHRyYSBdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB7IC4uLnJldCwgLi4ud2l0aEV4dHJhIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkKSB9O1xuICAgIH1cblxuICAgIF9nZXRBbGxSZWxhdGVkRmllbGRzKHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmICghcmVtb3RlRmllbGQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMocmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQuYnk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQ7XG4gICAgfVxuXG4gICAgX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KSB7XG4gICAgICAgIHJldHVybiBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMubWFwKGFzc29jID0+IHtcbiAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkgcmV0dXJuIGFzc29jLnNyY0ZpZWxkO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBsdXJhbGl6ZShhc3NvYy5kZXN0RW50aXR5KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFzc29jLmRlc3RFbnRpdHk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gYmVsb25nc1RvICAgICAgXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBoYXNNYW55L2hhc09uZSBbYnldIFt3aXRoXVxuICAgICAqIGhhc01hbnkgLSBzZW1pIGNvbm5lY3Rpb24gICAgICAgXG4gICAgICogcmVmZXJzVG8gLSBzZW1pIGNvbm5lY3Rpb25cbiAgICAgKiAgICAgIFxuICAgICAqIHJlbW90ZUZpZWxkOlxuICAgICAqICAgMS4gZmllbGROYW1lXG4gICAgICogICAyLiBhcnJheSBvZiBmaWVsZE5hbWVcbiAgICAgKiAgIDMuIHsgYnkgLCB3aXRoIH1cbiAgICAgKiAgIDQuIGFycmF5IG9mIGZpZWxkTmFtZSBhbmQgeyBieSAsIHdpdGggfSBtaXhlZFxuICAgICAqICBcbiAgICAgKiBAcGFyYW0geyp9IHNjaGVtYSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eSBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIFxuICAgICAqL1xuICAgIF9wcm9jZXNzQXNzb2NpYXRpb24oc2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzLCBwZW5kaW5nRW50aXRpZXMpIHtcbiAgICAgICAgbGV0IGVudGl0eUtleUZpZWxkID0gZW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGFzc2VydDogIUFycmF5LmlzQXJyYXkoZW50aXR5S2V5RmllbGQpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCBgUHJvY2Vzc2luZyBcIiR7ZW50aXR5Lm5hbWV9XCIgJHtKU09OLnN0cmluZ2lmeShhc3NvYyl9YCk7IFxuXG4gICAgICAgIGxldCBkZXN0RW50aXR5TmFtZSA9IGFzc29jLmRlc3RFbnRpdHksIGRlc3RFbnRpdHksIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG4gICAgICAgIFxuICAgICAgICBpZiAoaXNEb3RTZXBhcmF0ZU5hbWUoZGVzdEVudGl0eU5hbWUpKSB7XG4gICAgICAgICAgICAvL2Nyb3NzIGRiIHJlZmVyZW5jZVxuICAgICAgICAgICAgbGV0IFsgZGVzdFNjaGVtYU5hbWUsIGFjdHVhbERlc3RFbnRpdHlOYW1lIF0gPSBleHRyYWN0RG90U2VwYXJhdGVOYW1lKGRlc3RFbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgbGV0IGRlc3RTY2hlbWEgPSBzY2hlbWEubGlua2VyLnNjaGVtYXNbZGVzdFNjaGVtYU5hbWVdO1xuICAgICAgICAgICAgaWYgKCFkZXN0U2NoZW1hLmxpbmtlZCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVGhlIGRlc3RpbmF0aW9uIHNjaGVtYSAke2Rlc3RTY2hlbWFOYW1lfSBoYXMgbm90IGJlZW4gbGlua2VkIHlldC4gQ3VycmVudGx5IG9ubHkgc3VwcG9ydCBvbmUtd2F5IHJlZmVyZW5jZSBmb3IgY3Jvc3MgZGIgcmVsYXRpb24uYClcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGVzdEVudGl0eSA9IGRlc3RTY2hlbWEuZW50aXRpZXNbYWN0dWFsRGVzdEVudGl0eU5hbWVdOyBcbiAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUgPSBhY3R1YWxEZXN0RW50aXR5TmFtZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGRlc3RFbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGRlc3RFbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUgPSBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgfSAgIFxuICAgICAgICAgXG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiBkZXN0S2V5RmllbGQsIGBFbXB0eSBrZXkgZmllbGQuIEVudGl0eTogJHtkZXN0RW50aXR5TmFtZX1gOyBcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgXG4gICAgICAgICAgICAgICAgbGV0IGluY2x1ZGVzOyAgICBcbiAgICAgICAgICAgICAgICBsZXQgZXhjbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICB0eXBlczogWyAncmVmZXJzVG8nIF0sIFxuICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbjogYXNzb2MgXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICBleGNsdWRlcy50eXBlcy5wdXNoKCdiZWxvbmdzVG8nKTtcbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNiID0+IGNiICYmIGNiLnNwbGl0KCcuJylbMF0gPT09IGFzc29jLmJ5LnNwbGl0KCcuJylbMF0gXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLndpdGggPSBhc3NvYy53aXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGRzID0gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhhc3NvYy5yZW1vdGVGaWVsZCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IHJlbW90ZUZpZWxkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZCB8fCAocmVtb3RlRmllbGQgPSBlbnRpdHkubmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5pc05pbChyZW1vdGVGaWVsZHMpIHx8IChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkcykgPyByZW1vdGVGaWVsZHMuaW5kZXhPZihyZW1vdGVGaWVsZCkgPiAtMSA6IHJlbW90ZUZpZWxkcyA9PT0gcmVtb3RlRmllbGQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyB8fCBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdcIm0yblwiIGFzc29jaWF0aW9uIHJlcXVpcmVzIFwiYnlcIiBwcm9wZXJ0eS4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnIGRlc3RpbmF0aW9uOiAnICsgZGVzdEVudGl0eU5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvbmUvbWFueSB0byBvbmUvbWFueSByZWxhdGlvblxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGNvbm5lY3RlZCBieSBmaWVsZCBpcyB1c3VhbGx5IGEgcmVmZXJzVG8gYXNzb2NcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTsgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMiArPSAnICcgKyBiYWNrUmVmLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0czIgPSBiYWNrUmVmLmJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSAoY29ubmVjdGVkQnlQYXJ0czIubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzMlsxXSkgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiYnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRW50aXRpZXMucHVzaChjb25uRW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogcmVtb3RlRmllbGROYW1lIH0sIGRlc3RFbnRpdHkua2V5LCByZW1vdGVGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrUmVmLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGJhY2tSZWYud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMX1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMi13YXkgcmVmZXJlbmNlOiAke3RhZzJ9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBieS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFuY2hvciA9IGFzc29jLnNyY0ZpZWxkIHx8IChhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSkgOiBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkID0gYXNzb2MucmVtb3RlRmllbGQgfHwgYmFja1JlZi5zcmNGaWVsZCB8fCBlbnRpdHkubmFtZTtcblxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jaGVjayBpZiB0aGUgdGFyZ2V0IGVudGl0eSBoYXMgbG9naWNhbCBkZWxldGlvbiBmZWF0dXJlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHkuaGFzRmVhdHVyZSgnbG9naWNhbERlbGV0aW9uJykpIHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZGVsZXRpb25DaGVjayA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9vbFR5cGU6ICdCaW5hcnlFeHByZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnIT0nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGVmdDogeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogYCR7ZGVzdEVudGl0eU5hbWV9LiR7ZGVzdEVudGl0eS5mZWF0dXJlc1snbG9naWNhbERlbGV0aW9uJ10uZmllbGR9YCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IHRydWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQud2l0aCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvb2xUeXBlOiAnTG9naWNhbEV4cHJlc3Npb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnYW5kJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiByZW1vdGVGaWVsZC53aXRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJpZ2h0OiBkZWxldGlvbkNoZWNrXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogJ0xvZ2ljYWxFeHByZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcGVyYXRvcjogJ2FuZCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGVmdDogYXNzb2Mud2l0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByaWdodDogZGVsZXRpb25DaGVja1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPSBkZWxldGlvbkNoZWNrO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBkZXN0RW50aXR5LmtleSwgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBhbmNob3IgfSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmtleSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiByZW1vdGVGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiByZW1vdGVGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odHlwZW9mIHJlbW90ZUZpZWxkID09PSAnc3RyaW5nJyA/IHsgZmllbGQ6IHJlbW90ZUZpZWxkIH0gOiB7fSksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieSA/IGFzc29jLmJ5LnNwbGl0KCcuJykgOiBbIE9vbFV0aWxzLnByZWZpeE5hbWluZyhlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUpIF07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiogYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBjb25uRW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL2NyZWF0ZSBhXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBlbmRpbmdFbnRpdGllcy5wdXNoKGNvbm5FbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgYE5ldyBlbnRpdHkgXCIke2Nvbm5FbnRpdHkubmFtZX1cIiBhZGRlZCBieSBhc3NvY2lhdGlvbi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vdG9kbzogZ2V0IGJhY2sgcmVmIGZyb20gY29ubmVjdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMSA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIHsgdHlwZTogJ3JlZmVyc1RvJywgc3JjRmllbGQ6IChmKSA9PiBfLmlzTmlsKGYpIHx8IGYgPT0gY29ubmVjdGVkQnlGaWVsZCB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZW50aXR5Lm5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMiA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZGVzdEVudGl0eU5hbWUsIHsgdHlwZTogJ3JlZmVyc1RvJyB9LCB7IGFzc29jaWF0aW9uOiBjb25uQmFja1JlZjEgIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtkZXN0RW50aXR5TmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IGNvbm5CYWNrUmVmMi5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiYnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4gRGV0YWlsOiAnICsgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyYzogZW50aXR5Lm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdDogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IGFzc29jLnNyY0ZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApICxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMS13YXkgcmVmZXJlbmNlOiAke3RhZzF9YCk7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhZyA9IGAke2VudGl0eS5uYW1lfToxLSR7ZGVzdEVudGl0eU5hbWV9OiogJHtsb2NhbEZpZWxkfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnKSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCBieSBjb25uZWN0aW9uLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZyk7ICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgd2VlayByZWZlcmVuY2U6ICR7dGFnfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIGRlc3RLZXlGaWVsZCwgYXNzb2MuZmllbGRQcm9wcyk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkLCAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBkZXN0RW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UobG9jYWxGaWVsZCArICcuJyArIGRlc3RFbnRpdHkua2V5KSB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgLy9mb3JlaWduIGtleSBjb25zdHJhaXRzXG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGRPYmogPSBlbnRpdHkuZmllbGRzW2xvY2FsRmllbGRdOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGNvbnN0cmFpbnRzID0ge307XG5cbiAgICAgICAgICAgICAgICBpZiAobG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25VcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgPSBsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPblVwZGF0ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAobG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25EZWxldGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgPSBsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPbkRlbGV0ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgfHwgKGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gJ1JFU1RSSUNUJyk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9ICdSRVNUUklDVCcpO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChsb2NhbEZpZWxkT2JqLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlIHx8IChjb25zdHJhaW50cy5vblVwZGF0ZSA9ICdTRVQgTlVMTCcpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSAnU0VUIE5VTEwnKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnTk8gQUNUSU9OJyk7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gJ05PIEFDVElPTicpO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGVudGl0eS5uYW1lLCBsb2NhbEZpZWxkLCBkZXN0RW50aXR5TmFtZSwgZGVzdEtleUZpZWxkLm5hbWUsIGNvbnN0cmFpbnRzKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uKSB7XG4gICAgICAgIGFzc2VydDogb29sQ29uLm9vbFR5cGU7XG5cbiAgICAgICAgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJGVxJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICchPScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJG5lJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnVW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGFyZztcblxuICAgICAgICAgICAgc3dpdGNoIChvb2xDb24ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckZXEnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgXG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1ub3QtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGFyZyA9IG9vbENvbi5hcmd1bWVudDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlICYmIGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJnID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGFyZy5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbYXJnXTogeyAnJG5lJzogbnVsbCB9XG4gICAgICAgICAgICAgICAgICAgIH07ICAgICBcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIFVuYXJ5RXhwcmVzc2lvbiBvcGVyYXRvcjogJyArIG9vbENvbi5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIHN3aXRjaCAob29sQ29uLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnYW5kJzpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgJGFuZDogWyB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5sZWZ0KSwgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ucmlnaHQpIF0gfTtcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY2FzZSAnb3InOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgJG9yOiBbIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLmxlZnQpLCB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5yaWdodCkgXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIHN5bnRheDogJyArIEpTT04uc3RyaW5naWZ5KG9vbENvbikpO1xuICAgIH1cblxuICAgIF90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmVmLCBhc0tleSkge1xuICAgICAgICBsZXQgWyBiYXNlLCAuLi5vdGhlciBdID0gcmVmLnNwbGl0KCcuJyk7XG5cbiAgICAgICAgbGV0IHRyYW5zbGF0ZWQgPSBjb250ZXh0W2Jhc2VdO1xuICAgICAgICBpZiAoIXRyYW5zbGF0ZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZOYW1lID0gWyB0cmFuc2xhdGVkLCAuLi5vdGhlciBdLmpvaW4oJy4nKTtcblxuICAgICAgICBpZiAoYXNLZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKHJlZk5hbWUpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgbGVmdEZpZWxkLmZvckVhY2gobGYgPT4gdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxmLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZC5ieSwgcmlnaHQuIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGFzc2VydDogdHlwZW9mIGxlZnRGaWVsZCA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMgfSk7IFxuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihzY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmZWF0dXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmVhdHVyZS5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXBkYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNVcGRhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY2hhbmdlTG9nJzpcbiAgICAgICAgICAgICAgICBsZXQgY2hhbmdlTG9nU2V0dGluZ3MgPSBVdGlsLmdldFZhbHVlQnlQYXRoKHNjaGVtYS5kZXBsb3ltZW50U2V0dGluZ3MsICdmZWF0dXJlcy5jaGFuZ2VMb2cnKTtcblxuICAgICAgICAgICAgICAgIGlmICghY2hhbmdlTG9nU2V0dGluZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBNaXNzaW5nIFwiY2hhbmdlTG9nXCIgZmVhdHVyZSBzZXR0aW5ncyBpbiBkZXBsb3ltZW50IGNvbmZpZyBmb3Igc2NoZW1hIFske3NjaGVtYS5uYW1lfV0uYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFjaGFuZ2VMb2dTZXR0aW5ncy5kYXRhU291cmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjaGFuZ2VMb2cuZGF0YVNvdXJjZVwiIGlzIHJlcXVpcmVkLiBTY2hlbWE6ICR7c2NoZW1hLm5hbWV9YCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihmZWF0dXJlLCBjaGFuZ2VMb2dTZXR0aW5ncyk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBmZWF0dXJlIFwiJyArIGZlYXR1cmVOYW1lICsgJ1wiLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX3dyaXRlRmlsZShmaWxlUGF0aCwgY29udGVudCkge1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGNvbnRlbnQpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgZGIgc2NyaXB0OiAnICsgZmlsZVBhdGgpO1xuICAgIH1cblxuICAgIF9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5MU5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTJOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCkge1xuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdhdXRvSWQnLCAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAgaW5kZXhlczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJmaWVsZHNcIjogWyBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCBdLFxuICAgICAgICAgICAgICAgICAgICBcInVuaXF1ZVwiOiB0cnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIGFzc29jaWF0aW9uczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwicmVmZXJzVG9cIixcbiAgICAgICAgICAgICAgICAgICAgXCJkZXN0RW50aXR5XCI6IGVudGl0eTFOYW1lLFxuICAgICAgICAgICAgICAgICAgICBcInNyY0ZpZWxkXCI6IGVudGl0eTFSZWZGaWVsZFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJyZWZlcnNUb1wiLFxuICAgICAgICAgICAgICAgICAgICBcImRlc3RFbnRpdHlcIjogZW50aXR5Mk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwic3JjRmllbGRcIjogZW50aXR5MlJlZkZpZWxkXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gcmVsYXRpb25FbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkxIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MiBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTFOYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5Mk5hbWUgXG4gICAgICogQHBhcmFtIHsqfSBjb25uZWN0ZWRCeUZpZWxkIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZDIgXG4gICAgICovXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbkVudGl0eS5uYW1lO1xuXG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSB7ICAgICAgXG4gICAgICAgICAgICAvLyBjaGVjayBpZiB0aGUgcmVsYXRpb24gZW50aXR5IGhhcyB0aGUgcmVmZXJzVG8gYm90aCBzaWRlIG9mIGFzc29jaWF0aW9ucyAgICAgICAgXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIF8uZWFjaChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywgYXNzb2MgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTFOYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkxTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mk5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTJOYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkyID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKGhhc1JlZlRvRW50aXR5MSAmJiBoYXNSZWZUb0VudGl0eTIpIHtcbiAgICAgICAgICAgICAgICAvL3llcywgZG9uJ3QgbmVlZCB0byBhZGQgcmVmZXJzVG8gdG8gdGhlIHJlbGF0aW9uIGVudGl0eVxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB0YWcxID0gYCR7cmVsYXRpb25FbnRpdHlOYW1lfToxLSR7ZW50aXR5MU5hbWV9OiogJHtjb25uZWN0ZWRCeUZpZWxkfWA7XG4gICAgICAgIGxldCB0YWcyID0gYCR7cmVsYXRpb25FbnRpdHlOYW1lfToxLSR7ZW50aXR5Mk5hbWV9OiogJHtjb25uZWN0ZWRCeUZpZWxkMn1gO1xuXG4gICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpKSB7XG4gICAgICAgICAgICBhc3NlcnQ6IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMik7XG5cbiAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICBcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCBicmlkZ2luZyByZWZlcmVuY2U6ICR7dGFnMX1gKTtcblxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgIFxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIGJyaWRnaW5nIHJlZmVyZW5jZTogJHt0YWcyfWApO1xuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MU5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mk5hbWV9YCk7XG4gICAgICAgIH1cblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQsIGVudGl0eTEsIGtleUVudGl0eTEpO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLCBrZXlFbnRpdHkyKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTFOYW1lIH1cbiAgICAgICAgKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkMiwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5Mk5hbWUgfVxuICAgICAgICApO1xuXG4gICAgICAgIGxldCBhbGxDYXNjYWRlID0geyBvblVwZGF0ZTogJ1JFU1RSSUNUJywgb25EZWxldGU6ICdSRVNUUklDVCcgfTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxTmFtZSwga2V5RW50aXR5MS5uYW1lLCBhbGxDYXNjYWRlKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTJOYW1lLCBrZXlFbnRpdHkyLm5hbWUsIGFsbENhc2NhZGUpOyAgICAgICAgXG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIC8qXG4gICAgX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCkge1xuICAgICAgICBsZXQgZW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2RvYy5lbnRpdHldO1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKHN0YXJ0SW5kZXgrKyk7XG4gICAgICAgIGRvYy5hbGlhcyA9IGFsaWFzO1xuXG4gICAgICAgIGxldCBjb2xMaXN0ID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcykubWFwKGsgPT4gYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGspKTtcbiAgICAgICAgbGV0IGpvaW5zID0gW107XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZG9jLnN1YkRvY3VtZW50cykpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGRvYy5zdWJEb2N1bWVudHMsIChkb2MsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBbIHN1YkNvbExpc3QsIHN1YkFsaWFzLCBzdWJKb2lucywgc3RhcnRJbmRleDIgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCk7XG4gICAgICAgICAgICAgICAgc3RhcnRJbmRleCA9IHN0YXJ0SW5kZXgyO1xuICAgICAgICAgICAgICAgIGNvbExpc3QgPSBjb2xMaXN0LmNvbmNhdChzdWJDb2xMaXN0KTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2lucy5wdXNoKCdMRUZUIEpPSU4gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBzdWJBbGlhc1xuICAgICAgICAgICAgICAgICAgICArICcgT04gJyArIGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZE5hbWUpICsgJyA9ICcgK1xuICAgICAgICAgICAgICAgICAgICBzdWJBbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmxpbmtXaXRoRmllbGQpKTtcblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHN1YkpvaW5zKSkge1xuICAgICAgICAgICAgICAgICAgICBqb2lucyA9IGpvaW5zLmNvbmNhdChzdWJKb2lucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyBjb2xMaXN0LCBhbGlhcywgam9pbnMsIHN0YXJ0SW5kZXggXTtcbiAgICB9Ki9cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYCcgKyBlbnRpdHlOYW1lICsgJ2AgKFxcbic7XG5cbiAgICAgICAgLy9jb2x1bW4gZGVmaW5pdGlvbnNcbiAgICAgICAgXy5lYWNoKGVudGl0eS5maWVsZHMsIChmaWVsZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG5hbWUpICsgJyAnICsgTXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24oZmllbGQpICsgJyxcXG4nO1xuICAgICAgICB9KTtcblxuICAgICAgICAvL3ByaW1hcnkga2V5XG4gICAgICAgIHNxbCArPSAnICBQUklNQVJZIEtFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGVudGl0eS5rZXkpICsgJyksXFxuJztcblxuICAgICAgICAvL290aGVyIGtleXNcbiAgICAgICAgaWYgKGVudGl0eS5pbmRleGVzICYmIGVudGl0eS5pbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnICAnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICdVTklRVUUgJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3FsICs9ICdLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShpbmRleC5maWVsZHMpICsgJyksXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdiZWZvcmVFbmRDb2x1bW5EZWZpbml0aW9uOicgKyBlbnRpdHlOYW1lLCBsaW5lcyk7XG4gICAgICAgIGlmIChsaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIGxpbmVzLmpvaW4oJyxcXG4gICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gc3FsLnN1YnN0cigwLCBzcWwubGVuZ3RoLTIpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICdcXG4pJztcblxuICAgICAgICAvL3RhYmxlIG9wdGlvbnNcbiAgICAgICAgbGV0IGV4dHJhUHJvcHMgPSB7fTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5TmFtZSwgZXh0cmFQcm9wcyk7XG4gICAgICAgIGxldCBwcm9wcyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuX2RiT3B0aW9ucy50YWJsZSwgZXh0cmFQcm9wcyk7XG5cbiAgICAgICAgc3FsID0gXy5yZWR1Y2UocHJvcHMsIGZ1bmN0aW9uKHJlc3VsdCwgdmFsdWUsIGtleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdCArICcgJyArIGtleSArICc9JyArIHZhbHVlO1xuICAgICAgICB9LCBzcWwpO1xuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG4gICAgXG4gICAgX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoZW50aXR5TmFtZSwgcmVsYXRpb24sIHNjaGVtYVRvQ29ubmVjdG9yLyosIG1hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWUqLykge1xuICAgICAgICBsZXQgcmVmVGFibGUgPSByZWxhdGlvbi5yaWdodDtcblxuICAgICAgICBpZiAocmVmVGFibGUuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgICAgICAgbGV0IFsgc2NoZW1hTmFtZSwgcmVmRW50aXR5TmFtZSBdID0gcmVmVGFibGUuc3BsaXQoJy4nKTsgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IHRhcmdldENvbm5lY3RvciA9IHNjaGVtYVRvQ29ubmVjdG9yW3NjaGVtYU5hbWVdO1xuICAgICAgICAgICAgYXNzZXJ0OiB0YXJnZXRDb25uZWN0b3I7XG5cbiAgICAgICAgICAgIHJlZlRhYmxlID0gdGFyZ2V0Q29ubmVjdG9yLmRhdGFiYXNlICsgJ2AuYCcgKyByZWZFbnRpdHlOYW1lO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlZlRhYmxlICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSBgT04gVVBEQVRFICR7cmVsYXRpb24uY29uc3RyYWludHMub25VcGRhdGV9IE9OIERFTEVURSAke3JlbGF0aW9uLmNvbnN0cmFpbnRzLm9uRGVsZXRlfTtcXG5gO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHsgICAgICBcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mb1snZGVmYXVsdCddO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChUeXBlcy5CT09MRUFOLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3RvZG86IG90aGVyIHR5cGVzXG5cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgICAgIGlmIChVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFLmhhcyh0eXBlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nIHx8IGluZm8udHlwZSA9PT0gJ2ludGVnZXInIHx8IGluZm8udHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2VudW0nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArICBxdW90ZShpbmZvLnZhbHVlc1swXSk7XG4gICAgICAgICAgICAgICAgfSAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgXCJcIic7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuICAgIFxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgPT09ICdvYmplY3QnICYmIGluZm8uZGVmYXVsdC5vb2xUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRCeURiID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoZGVmYXVsdFZhbHVlLm5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3cnOlxuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgTk9XJ1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICBcbiAgICAgICAgKi8gICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=