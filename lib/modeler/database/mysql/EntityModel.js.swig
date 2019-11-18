const { _ } = require('rk-utils');

const { 
    Types,
    Activators,
    Validators, 
    Processors, 
    Generators, 
    Errors: { BusinessError, DataValidationError, DsOperationError }, 
    Utils: { Lang: { isNothing } } 
} = require('@k-suite/oolong');
{{ imports|safe }} 

module.exports = (db, BaseEntityModel) => {
    let Base = BaseEntityModel;
    {% for m in mixins %}Base = {{m}}(Base);
    {% endfor %}
    const {{ className }}Spec = class extends Base {    
        {{ classBody|safe }}
    };

    {{ className }}Spec.db = db;
    {{ className }}Spec.meta = {{ entityMeta|safe }};

    return Object.assign({{ className }}Spec, {{ functors|safe }});
};