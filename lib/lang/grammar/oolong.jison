/* Oolong Parser for Jison */

/* JS declaration */
%{
    const DBG_MODE = !!process.env.OOL_DBG;

    //used to calculate the amount by bytes unit
    const UNITS = new Map([['K', 1024], ['M', 1048576], ['G', 1073741824], ['T', 1099511627776]]);

    //paired brackets
    const BRACKET_PAIRS = {
        '}': '{',
        ']': '[',
        ')': '('
    };

    //top level keywords
    const TOP_LEVEL_KEYWORDS = new Set(['import', 'type', 'const', 'schema', 'entity', 'dataset', 'view']);

    //allowed  keywords of differenty state
    const SUB_KEYWORDS = { 
        // level 1
        'schema': new Set(['entities', 'views']),
        'entity': new Set([ 'is', 'extends', 'with', 'has', 'associations', 'key', 'index', 'data', 'interface', 'mixes', 'code', 'triggers', 'restful' ]),
        'dataset': new Set(['is']),
    
        // level 2
        'entity.associations': new Set(['hasOne', 'hasMany', 'refersTo', 'belongsTo']),
        'entity.index': new Set(['is', 'unique']),
        'entity.interface': new Set(['accept', 'find', 'findOne', 'return']),
        'entity.triggers': new Set(['onCreate', 'onCreateOrUpdate', 'onUpdate', 'onDelete']),  
        'entity.restful': new Set(['create', 'findOne', 'findAll', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany']),              
        'entity.data': new Set(['in']),

        'dataset.body': new Set(['with']),

        // level 3
        'entity.associations.item': new Set(['connectedBy', 'being', 'with', 'as']),        
        'entity.interface.find': new Set(['a', 'an', 'the', 'one', 'by', 'cases', 'selected', 'selectedBy', "of", "which", "where", "when", "with", "otherwise", "else"]),           
        'entity.interface.return': new Set(["unless", "when"]),       
        'entity.triggers.onChange': new Set(["when"]), 
        'entity.restful.method': new Set(['allow', 'disallow', 'presetOfOrder', 'presetOptions', 'nested', 'id']),                          

        // level 4
        'entity.associations.item.block': new Set(['when']),           
        'entity.interface.find.when': new Set(['when', 'else', 'otherwise']),           
        'entity.interface.find.else': new Set(['return', 'throw']),
        'entity.interface.return.when': new Set(['exists', 'null', 'throw']),
        'entity.restful.method.allow': new Set(['anonymous', 'self']),        

        // level 5
        'entity.associations.item.block.when': new Set(['being', 'with' ])               
    };

    //next state transition table
    const NEXT_STATE = {        
        'import.*': 'import.item',
        'type.*': 'type.item',
        'const.*': 'const.item',
        'import.$INDENT': 'import.block',
        'type.$INDENT': 'type.block',
        'const.$INDENT': 'const.block',
        'entity.with': 'entity.with', 
        'entity.has': 'entity.has', 
        'entity.key': 'entity.key', 
        'entity.index': 'entity.index', 
        'entity.data': 'entity.data', 
        'entity.mixes': 'entity.mixes', 
        'entity.code': 'entity.code', 

        'entity.associations': 'entity.associations',
        'entity.associations.hasOne': 'entity.associations.item',
        'entity.associations.hasMany': 'entity.associations.item',
        'entity.associations.refersTo': 'entity.associations.item',
        'entity.associations.belongsTo': 'entity.associations.item',
        'entity.associations.item.$INDENT': 'entity.associations.item.block',
        'entity.associations.item.block.when': 'entity.associations.item.block.when',

        'entity.interface': 'entity.interface',
        'entity.interface.accept': 'entity.interface.accept',
        'entity.interface.accept.$INDENT': 'entity.interface.accept.block',
        'entity.interface.find': 'entity.interface.find',
        'entity.interface.findOne': 'entity.interface.find',
        'entity.interface.return': 'entity.interface.return',
        'entity.interface.return.when': 'entity.interface.return.when',
        'entity.interface.find.when': 'entity.interface.find.when',
        'entity.interface.find.otherwise': 'entity.interface.find.else',
        'entity.interface.find.else': 'entity.interface.find.else',

        'entity.triggers': 'entity.triggers',
        'entity.triggers.onCreate': 'entity.triggers.onChange',
        'entity.triggers.onCreateOrUpdate': 'entity.triggers.onChange',
        'entity.triggers.onUpdate': 'entity.triggers.onChange',
        'entity.triggers.onDelete': 'entity.triggers.onChange',
        'entity.triggers.onChange.when': 'entity.triggers.onChange.when',

        'entity.restful': 'entity.restful',
        'entity.restful.*': 'entity.restful.method',         
        'entity.restful.method.allow': 'entity.restful.method.allow',
        'entity.restful.method.nested': 'entity.restful.method.nested',
        'entity.restful.method.nested.*': 'entity.restful.method.nested.item',
        'entity.restful.method.presetOfOrder': 'entity.restful.method.presetOfOrder',
        'entity.restful.method.presetOfOrder.$INDENT': 'entity.restful.method.presetOfOrder.block',

        'dataset.is': 'dataset.body'
    };

    //exit number of states on dedent if exists in below table
    const DEDENT_STOPPER = new Map([                        
        [ 'entity.with', 1 ],
        [ 'entity.has', 1 ],               
        [ 'entity.data', 1 ], 
        [ 'entity.index', 1 ], 
        [ 'entity.associations', 1 ],
        [ 'entity.associations.item', 2 ],
        [ 'entity.associations.item.block.when', 2 ],        
        [ 'entity.interface.accept.block', 2 ],
        [ 'entity.interface.find.else', 2],
        [ 'entity.restful', 1 ],          
        [ 'entity.restful.method', 1 ],

        [ 'entity.restful.method.allow', 2],
        [ 'entity.restful.method.nested.item', 1],
        [ 'entity.restful.method.nested', 2 ],
        [ 'entity.restful.method.presetOfOrder', 2 ],

        [ 'entity.restful.method.presetOfOrder.block', 2]
    ]);

    //exit number of states on newline if exists in below table
    const NEWLINE_STOPPER = new Map([                
        [ 'import.item', 2 ],
        [ 'type.item', 2 ],
        [ 'const.item', 2 ],      
        [ 'entity.mixes', 1 ],
        [ 'entity.code', 1 ],
        [ 'entity.key', 1 ],   
        [ 'entity.data', 1 ],     
        [ 'entity.interface.accept', 1 ],       
        [ 'entity.interface.find.when', 1], 
        [ 'entity.interface.find.else', 1], 
        [ 'entity.interface.return.when', 1 ],         
        [ 'entity.associations.item', 1 ],        
        [ 'entity.associations.item.block.when', 1 ],
        [ 'entity.restful.method.allow', 1],
        [ 'entity.restful.method.nested.item', 1]
    ]);

    //in below states, certain tokens are allowed
    const ALLOWED_TOKENS = new Map([
        [ 'entity.restful', new Set(['route_literal']) ], 
        [ 'entity.restful.method.nested', new Set([ 'route_literal' ]) ],        
        [ 'entity.interface.find.when', new Set([ 'word_operators' ]) ],
        [ 'entity.interface.return.when', new Set([ 'word_operators' ]) ],
        [ 'entity.associations.item', new Set([ 'word_operators' ]) ],
        [ 'entity.associations.item.block.when', new Set([ 'word_operators' ]) ],
        [ 'entity.triggers.onChange.when', new Set([ 'word_operators' ]) ]
    ]);

    //indented child starting state
    const CHILD_KEYWORD_START_STATE = new Set([ 'EMPTY', 'DEDENTED' ]);    
    
    const BUILTIN_TYPES = new Set([ 'any', 'array', 'binary', 'blob', 'bool', 'boolean', 'buffer', 'datetime', 'decimal', 'enum', 'float', 'int', 'integer', 'number', 'object', 'string', 'text', 'timestamp' ]);

    class ParserState {
        constructor() {
            this.indents = [];
            this.indent = 0;
            this.dedented = 0;
            this.eof = false;
            this.comment = false;
            this.brackets = [];
            this.state = {};
            this.stack = [];
            this.newlineStopFlag = [];
        }

        get hasOpenBracket() {
            return this.brackets.length > 0;
        }

        get lastIndent() {
            return this.indents.length > 0 ? this.indents[this.indents.length - 1] : 0;
        }

        get hasIndent() {
            return this.indents.length > 0;
        }

        markNewlineStop(flag) {
            this.newlineStopFlag[this.newlineStopFlag.length-1] = flag;
        }

        doIndent() {
            this.indents.push(this.indent);

            let nextState = NEXT_STATE[this.lastState + '.$INDENT'];
            if (nextState) {
                state.enterState(nextState);
            }
        }

        doDedent() {
            this.dedented = 0;

            while (this.indents.length) {
                this.dedented++;
                this.indents.pop();
                if (this.lastIndent === this.indent) break;
            }

            if (this.lastIndent !== this.indent) {
                throw new Error('Cannot align to any of the previous indented block!');
            }

            if (this.dedented === 0) {
                throw new Error('Inconsistent indentation!');
            }
        }

        doDedentExit() {
            let exitRound = DEDENT_STOPPER.get(state.lastState);
            if (exitRound > 0) {

                for (let i = 0; i < exitRound; i++) {                    
                    state.exitState(state.lastState);
                }   
            }
        }

        doNewline() {
            if (this.newlineStopFlag[this.newlineStopFlag.length-1]) {
                if (!NEWLINE_STOPPER.has(state.lastState)) {
                    throw new Error('Inconsistent newline stop flag.');
                }

                let exitRound = NEWLINE_STOPPER.get(state.lastState);

                if (exitRound > 0) {                    

                    for (let i = 0; i < exitRound; i++) {                    
                        state.exitState(state.lastState);
                    }              
                }  
            }        
        }

        dedentAll() {
            this.indent = 0;
            this.dedented = this.indents.length;
            this.indents = [];
        }

        matchAnyExceptNewline() {
            let keywordChain = state.lastState + '.*';
            let nextState = NEXT_STATE[keywordChain];
            if (nextState) {
                state.enterState(nextState);                                                                        
            }
        }

        dump(loc, token) {
            if (DBG_MODE) {
                token ? console.log(loc, token) : console.log(loc);
                console.log('indents:', this.indents.join(' -> '), 'current indent:', this.indent, 'current dedented:', this.dedented, 'nl-stop', this.newlineStopFlag);                   
                console.log('lastState:', this.lastState, 'comment:', this.comment, 'eof:', this.eof, 'brackets:', this.brackets.join(' -> '),'stack:', this.stack.join(' -> '));
                console.log();
            }
            
            return this;
        }

        enterObject() {            
            return this.enterState('object');
        }

        exitObject() {            
            return this.exitState('object');
        }

        enterArray() {
            return this.enterState('array');
        }

        exitArray() {
            return this.exitState('array');
        }

        get lastState() {
            return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
        }

        enterState(state) {
            if (DBG_MODE) {
                console.log('> enter state:', state, '\n');
            }
            this.stack.push(state);
            this.newlineStopFlag.push(NEWLINE_STOPPER.has(state) ? true : false);
            return this;
        }

        exitState(state) {
            if (DBG_MODE) {
                console.log('< exit state:', state, '\n');
            }
            let last = this.stack.pop();
            if (state !== last) {
                throw new Error(`Unmatched "${state}" state!`);
            }

            this.newlineStopFlag.pop();

            return this;
        }

        parseSize(size) {
            if (UNITS.has(size.substr(-1))) {
                let unit = size.substr(-1);
                let factor = UNITS[unit];
        
                size = size.substr(0, size.length - 1);
        
                return parseInt(size) * factor;
            } else {
                return parseInt(size);
            }
        }
        
        unquoteString(str, quotes) {
            return str.substr(quotes, str.length-quotes*2);
        }

        isQuote(str) {
            return (str.startsWith('"') && str.endsWith('"')) ||
                (str.startsWith("'") && str.endsWith("'"));
        }

        normalizeSymbol(ref) {
            return { oorType: 'SymbolToken', name: ref.substr(2) };
        }                
        
        normalizeReference(ref) {
            let name = ref.substr(1);

            return { 
                oolType: 'ObjectReference', 
                name: this.isQuote(name) ? this.unquoteString(name, 1) : name 
            };
        }

        normalizeOptionalReference(ref) {            
            return { ...ref, optional: true };
        }

        normalizeConstReference(ref) {
            return { oolType: 'ConstReference', name: ref };
        }

        normalizeStringTemplate(text) {
            return { oolType: 'StringTemplate', value: this.unquoteString(text, 1) };
        }    

        normalizeValidator(name, args) {
            if (args) {
                return { oolType: 'Validator', name, args };
            } 
                
            return { oolType: 'Validator', name  };
        }

        normalizeRegExp(regexp) {                
            return { oolType: 'RegExp', value: regexp };
        }

        normalizeScript(script) {                
            return { oolType: 'JavaScript', value: script };
        }

        normalizeProcessor(name, args) {
            if (args) {
                return { oolType: 'Processor', name, args };
            } 
                
            return { oolType: 'Processor', name  };
        }

        normalizeActivator(name, args) {
            if (args) {
                return { oolType: 'Activator', name, args };
            } 
                
            return { oolType: 'Activator', name  };
        }

        normalizePipedValue(value, modifiers) {
            return Object.assign({ oolType: 'PipedValue', value }, modifiers);
        }

        normalizeFunctionCall(func) {
            return Object.assign({ oolType: 'FunctionCall' }, func);
        }

        isTypeExist(type) {
            return this.state.type && (type in this.state.type);
        }    

        validate() {
            let errors = [];

            if (errors && errors.length > 0) {
                throw new Error(errors.join("\n"));
            }

            return this;
        }

        build() {
            return this.state;
        }

        import(namespace) {
            if (!this.state.namespace) {
                this.state.namespace = [];
            }

            this.state.namespace.push(namespace);
        }  
        
        define(type, name, value, line) {
            if (!this.state[type]) {
                this.state[type] = {};
            }

            if (name in this.state[type]) {
                throw new Error(`Duplicate ${type} definition detected at line ${line}.`);
            }

            this.state[type][name] = value;
        }

        defineConstant(name, value, line) {
            this.define('constant', name, value, line);
        }

        defineType(name, value, line) {
            if (!value.type) {
                throw new Error(`Missing type property for type "${name}" at line: ${line}!`);
            }

            this.define('type', name, value, line);
        }

        isTypeExist(type) {
            return this.state.type && (type in this.state.type);
        }
        
        defineEntity(name, value, line) {
            this.define('entity', name, value, line);
        }

        isEntityExist(entity) {
            return this.state.entity && (entity in this.state.entity);
        }

        addToEntity(name, extra) {
            if (!this.isEntityExist(name)) {
                throw new Error(`Entity "${name}" not exists.`);
            }

            Object.assign(this.state.entity[name], extra);
        }

        defineSchema(name, value, line) {
            this.define('schema', name, value, line);    
        }

        defineRelation(name, value, line) {
            this.define('relation', name, value, line);    
        }

        defineView(name, value, line) {
            this.define('view', name, value, line);
        }

        defineDataset(name, value, line) {
            this.define('dataset', name, value, line);
        }
    }

    function merge(obj1, obj2) {
        let m = Object.assign({}, obj1);

        for (let k in obj2) {
            let v2 = obj2[k];
            let t2 = typeof v2;

            if (k in obj1) {
                let v1 = obj1[k];
                let t1 = typeof v1;

                if ((t1 === 'object' && !Array.isArray(v1)) || (t2 === 'object' && !Array.isArray(v2))) {
                    if (t1 !== 'undefined' && t1 !== 'object') {
                        throw new Error(`Failed to merge object propery "${k}".`);
                    }

                    if (t2 !== 'undefined' && t2 !== 'object') {
                        throw new Error(`Failed to merge object propery "${k}".`);
                    }

                    m[k] = Object.assign({}, v1, v2);
                    continue;
                }

                Array.isArray(v1) || (v1 = [ v1 ]);
                Array.isArray(v2) || (v2 = [ v2 ]);
                m[k] = v1.concat(v2);
                continue;
            }

            m[k] = v2;
        }

        return m;
    }

    let state; // created on start
%}

%lex

%options easy_keyword_rules
%options flex

uppercase               [A-Z]
lowercase               [a-z]
digit                   [0-9]

space           		\ |\t
newline		            \n|\r\n|\r|\f

// identifiers
element_access          {variable}"["({space})*?({variable}|{shortstring}|{integer})({space})*?"]"
member_access           {identifier}("."{identifier})+
variable                {member_access}|{identifier}
object_reference        "@"({variable}|{shortstring})
symbol_token            "@""@"{identifier}

identifier              ({id_start})({id_continue})*
id_start                "_"|"$"|({uppercase})|({lowercase})
id_continue             {id_start}|{digit}               

bool_value              "true"|"false"|"yes"|"no"|"on"|"off"

// numbers 
bytes                   {integer}("B"|"b")
bit_integer             {integer}("K"|"M"|"G"|"T")
big_integer             {integer}"n"
integer                 ({decinteger})|({hexinteger})|({octinteger})
decinteger              ("-")?(([1-9]{digit}*)|"0")
hexinteger              "0"[x|X]{hexdigit}+
octinteger              "0"[o|O]{octdigit}+
bininteger              "0"[b|B]{bindigit}+
hexdigit                {digit}|[a-fA-F]
octdigit                [0-7]
bindigit                [0|1]

floatnumber             {exponentfloat}|{pointfloat}
exponentfloat           ("-")?({digit}+|{pointfloat}){exponent}
pointfloat              ("-")?({digit}*{fraction})|({digit}+".")
fraction                "."{digit}+
exponent                [e|E][\+|\-]({digit})+

// regexp literal
regexp                  "/"{regexp_item}*"/"{regexp_flag}*
regexp_item             {regexp_char}|{escapeseq}
regexp_char             [^\\\n\/]
regexp_flag             "i"|"g"|"m"|"y"

// path literal
route_literal            ("/"{route_identifier})+
route_identifier         (":")?{id_start}{id_continue}*
route_only_one_node      "/"{identifier}

symbol_operators        {relation_operators}|{syntax_operators}|{math_operators}
word_operators          {logical_operators}|{relation_operators2}|{predicate_operators}
bracket_operators       "("|")"|"["|"]"|"{"|"}"
syntax_operators        "|~"|","|":"|"|>"|"|="|"--"|"=>"|"~"|"="|"->"
comment_operators       "//"
relation_operators      "!="|">="|"<="|">"|"<"|"=="
logical_operators       "not"|"and"|"or"
math_operators          "+"|"-"|"*"|"/"|"%"
relation_operators2     "in"|"is"|"like"
predicate_operators     "exists"|"null"|"all"|"any"

// javascript
javascript              "<js>"{longstringitem}*?"</js>"
block_comment           "/*"{longstringitem}*?"*/"

// strings
jststring               "`"{longstringitem}*?"`"

longstring              {longstring_double}|{longstring_single}
longstring_double       '"""'{longstringitem}*?'"""'
longstring_single       "'''"{longstringitem}*?"'''"
longstringitem          {longstringchar}|{escapeseq}
longstringchar          [^\\]

shortstring             {shortstring_double}|{shortstring_single}
shortstring_double      '"'{shortstringitem_double}*?'"'
shortstring_single      "'"{shortstringitem_single}*?"'"
shortstringitem_double  {shortstringchar_double}|{escapeseq}
shortstringitem_single  {shortstringchar_single}|{escapeseq}
shortstringchar_single  [^\\\n\']
shortstringchar_double  [^\\\n\"]
escapeseq               \\.

// INITIAL program start
// EMPTY new line start
// DEDENTS after DEDENTS
// INLINE inline
// OBJECT_KEY inside a object, key part
// OBJECT_VALUE inside a array, value part
// ARRAY inside a array
// FUNCTION
%s INITIAL EMPTY DEDENTED INLINE REPARSE

%%

<INITIAL><<EOF>>        return 'EOF';

<INITIAL>.|\n           %{  //start the program
                            state = new ParserState();
                            this.unput(yytext);
                            this.begin('EMPTY');
                        %}

<EMPTY><<EOF>>          %{ 
                            if (state.indents.length > 0) {
                                //reach end-of-file, but a current block still not in ending state

                                //put back the eof
                                this.unput(' ');

                                //dedent all
                                state.dedentAll();
                                state.eof = true;
                                state.dump('<EMPTY><<EOF>>');
                                this.begin('DEDENTED');

                            } else {          
                                state.dump('<EMPTY><<EOF>>');                      
                                return 'EOF';
                            }
                        %}
<EMPTY>\                %{ state.indent++; %}
<EMPTY>\t               %{ state.indent = (state.indent + 8) & -7; %}
<EMPTY>\n               %{ state.indent = 0; if (state.comment) state.comment = false; %} // blank line
<EMPTY,INLINE>{comment_operators}.*      %{ state.comment = true; %} /* skip comments */
<EMPTY,INLINE>{block_comment}  %{  /* skip comments */ %}
<EMPTY>.                %{
                            this.unput( yytext )
                            //compare the current indents with the last
                            var last = state.lastIndent;
                            if (state.indent > last) {
                                //new indent
                                state.doIndent();
                                this.begin('INLINE');
                                state.dump('<EMPTY>. indent');                                                            
                                return 'INDENT';

                            } else if (state.indent < last) {
                                //dedent
                                state.doDedent();
                                this.begin('DEDENTED');                                  

                                state.dump('<EMPTY>. dedent');                                   
                            } else {
                                state.doNewline();

                                //same indent
                                if (state.hasIndent) {
                                    let nextState = NEXT_STATE[state.lastState + '.$INDENT'];
                                    if (nextState) {
                                        state.enterState(nextState);
                                    }
                                }

                                this.begin('INLINE');                                                                                                               

                                state.dump('<EMPTY>. same indent');                                       
                            }
                        %}
<DEDENTED>.|<<EOF>>     %{
                            if (state.dedented > 0 && state.dedentFlip) {
                                this.unput(yytext);
                                state.dump('<DEDENTED>.|<<EOF>> DEDENT return NEWLINE');          
                                state.dedentFlip = false;
                                return 'NEWLINE';
                            }

                            if (state.dedented > 0) {                                
                                state.dedented--;

                                this.unput(yytext);                                        
                                state.doDedentExit();
                                state.dump('<DEDENTED>.|<<EOF>> DEDENT');        

                                state.dedentFlip = true;                                
                                return 'DEDENT';
                            } 
                            
                            if (state.eof) {

                                this.popState();
                                state.dump('<DEDENTED>.|<<EOF>> pop');
                                while (state.lastState) {
                                    state.exitState(state.lastState);                      
                                }

                            } else {
                                if (state.indent === 0) {
                                    while (state.lastState) {
                                        state.exitState(state.lastState);                      
                                    }
                                }

                                state.dedentFlip = false;

                                state.dedented = 0;
                                this.unput(yytext);
                                this.begin('INLINE');
                                state.dump('<DEDENTED>.|<<EOF>> INLINE');
                            }
                        %}
<INLINE><<EOF>>         %{
                            if (state.indents.length > 0) {
                                //reach end-of-file, but a current block still not in ending state

                                //put back the eof
                                this.unput(' ');

                                //dedent all
                                state.dedentAll();
                                state.eof = true;
                                state.dump('<INLINE><<EOF>>');
                                this.begin('DEDENTED');
                                return 'NEWLINE';

                            } else {                                
                                state.dump('<INLINE><<EOF>>');   

                                if (state.lastState) {
                                 
                                    state.doNewline();
                                    
                                    //put back the eof
                                    this.unput(' ');
                                    state.eof = true;
                                    this.begin('EMPTY');
                                    return 'NEWLINE';
                                }

                                return 'EOF';
                            }
                        %}       
<INLINE>{javascript}    %{
                            state.matchAnyExceptNewline();                            

                            yytext = state.normalizeScript(yytext.substr(4, yytext.length-9).trim());
                            return 'SCRIPT';
                        %}
<INLINE>{jststring}     %{
                            state.matchAnyExceptNewline();

                            yytext = state.normalizeStringTemplate(yytext);
                            return 'STRING';
                        %}

<INLINE>{longstring}    %{
                            state.matchAnyExceptNewline();

                            yytext = state.unquoteString(yytext, 3);
                            return 'STRING';
                        %}
<INLINE>{shortstring}   %{
                            state.matchAnyExceptNewline();

                            yytext = state.unquoteString(yytext, 1);
                            return 'STRING';
                        %}
<INLINE>{newline}       %{
                            // implicit line joining
                            if (!state.hasOpenBracket) {                                
                                this.begin('EMPTY');

                                if (state.comment) {
                                    state.comment = false;
                                }

                                state.dump('<INLINE>{newline}');                                
                                state.indent = 0;                     

                                return 'NEWLINE';
                            }
                        %}
<INLINE>{space}+       /* skip whitespace, separate tokens */
<INLINE>{regexp}        %{
                            state.matchAnyExceptNewline();

                            yytext = state.normalizeRegExp(yytext);
                            return 'REGEXP';
                        %}   
<INLINE>{floatnumber}   %{
                            state.matchAnyExceptNewline();

                            yytext = parseFloat(yytext);
                            return 'FLOAT';
                        %}
<INLINE>{bit_integer}   %{
                            state.matchAnyExceptNewline();

                            yytext = state.parseSize(yytext);
                            return 'INTEGER';
                        %}
<INLINE>{bytes}         %{
                            state.matchAnyExceptNewline();

                            yytext = parseInt(yytext.substr(0, yytext.length - 1));
                            if (yytext[yytext.length - 1] === 'B') {
                                yytext *= 8;
                            }
                            return 'BITS';
                        %}
<INLINE>{integer}       %{
                            state.matchAnyExceptNewline();

                            yytext = parseInt(yytext);
                            return 'INTEGER';
                        %}
<INLINE>{element_access}   %{     
                                state.matchAnyExceptNewline();

                                return 'ELEMENT_ACCESS';
                           %}                        
<INLINE>{member_access}    %{      
                                state.matchAnyExceptNewline();

                                return 'DOTNAME';
                           %}
<INLINE>{symbol_token}     %{
                                state.matchAnyExceptNewline();

                                yytext = state.normalizeSymbol(yytext);
                                return 'SYMBOL';
                           %}                      
<INLINE>{object_reference} %{
                                state.matchAnyExceptNewline();

                                yytext = state.normalizeReference(yytext);
                                return 'REFERENCE';
                           %}
<INLINE>{bracket_operators}     %{
                                    state.matchAnyExceptNewline();

                                    if (yytext == '{' || yytext == '[' || yytext == '(') {
                                        state.brackets.push(yytext);
                                    } else if (yytext == '}' || yytext == ']' || yytext == ')') {
                                        var paired = BRACKET_PAIRS[yytext];
                                        var lastBracket = state.brackets.pop();
                                        if (paired !== lastBracket) {
                                            throw new Error("Inconsistent bracket.")
                                        }
                                    }

                                    if (yytext == '{') {
                                        state.enterObject();
                                    } else if (yytext == '}') {
                                        state.exitObject();
                                    } else if (yytext == '[') {
                                        state.enterArray();
                                    } else if (yytext == ']') {
                                        state.exitArray();
                                    }

                                    return yytext;
                                %}
<INLINE>{bool_value}       %{
                                state.matchAnyExceptNewline();

                                yytext = (yytext === 'true' || yytext === 'on' || yytext === 'yes');
                                return 'BOOL';
                           %}
<INLINE>{word_operators}    %{
                                state.dump(this.topState(1) + ' -> <INLINE>{word_operators}', yytext);                                     
                                
                                if (ALLOWED_TOKENS.has(state.lastState) && ALLOWED_TOKENS.get(state.lastState).has('word_operators')) {    
                                    return yytext;
                                } else {
                                    this.unput(yytext);
                                    this.begin('REPARSE');
                                }                                
                            %}
<INLINE>{route_literal}    %{
                                state.dump(this.topState(1) + ' -> <INLINE>{route_literal}', yytext);                                     

                                if (ALLOWED_TOKENS.has(state.lastState) && ALLOWED_TOKENS.get(state.lastState).has('route_literal')) {
                                    return 'ROUTE';
                                } else {
                                    this.unput(yytext);
                                    this.begin('REPARSE');
                                }                                
                            %}                            
<REPARSE,INLINE>{identifier}        %{        
                                if (this.topState(0) !== 'INLINE') {
                                    this.begin('INLINE');
                                }
                                if (!state.lastState) {
                                    if (TOP_LEVEL_KEYWORDS.has(yytext)) {
                                        state.enterState(yytext);
                                        return yytext;
                                    }

                                    throw new Error(`Invalid syntax: ${yytext}`);
                                }       

                                state.dump(this.topState(1) + ' -> <INLINE>{identifier}', yytext); 
                                
                                if (SUB_KEYWORDS[state.lastState] && SUB_KEYWORDS[state.lastState].has(yytext)) {                                    
                                    let keywordChain = state.lastState + '.' + yytext;
                                    let nextState = NEXT_STATE[keywordChain];
                                    if (nextState) {
                                        state.enterState(nextState);                                                                        
                                    } else {
                                        state.matchAnyExceptNewline();
                                    }

                                    return yytext;
                                } else {
                                    state.matchAnyExceptNewline();
                                }

                                return 'NAME';
                            %}
<INLINE>{symbol_operators}  return yytext;

/lex

%right "="
%left "=>"
%right "|>" "|~" "|="
%left "or"
%left "and"
%nonassoc "in" "is" "like" "~"
%left "not"
%left "!=" ">=" "<=" ">" "<" "=="
%left "+" "-"
%left "*" "/" "%"

%ebnf

%start program

%%

/** grammar **/
program
    : input 
        {
            var r = state;
            state = null;
            return r ? r.validate().build() : '';
        }
    ;

input
    : EOF
    | input0 EOF
    ;

input0
    : statement
    | statement input0
    ;

statement
    : import_statement    
    | const_statement
    | type_statement
    | schema_statement    
    | entity_statement
    | view_statement
    | dataset_statement
    ;

import_statement
    : "import" identifier_or_string NEWLINE -> state.import($2) 
    | "import" NEWLINE INDENT import_statement_block DEDENT NEWLINE?
    ;

import_statement_block
    : identifier_or_string NEWLINE -> state.import($1)
    | identifier_or_string NEWLINE import_statement_block -> state.import($1)
    ;

const_statement
    : "const" const_statement_item NEWLINE
    | "const" NEWLINE INDENT const_statement_block DEDENT NEWLINE?
    ;

const_statement_item
    : identifier "=" literal
        {
            state.defineConstant($1, $3, @1.first_line);   
        }
    ;

const_statement_block
    : const_statement_item NEWLINE
    | const_statement_item NEWLINE const_statement_block
    ;

schema_statement
    : "schema" identifier_or_string NEWLINE INDENT schema_statement_block DEDENT NEWLINE? -> state.defineSchema($2, $5, @1.first_line)
    ;

schema_statement_block
    : comment_or_not schema_entities? schema_views_or_not -> Object.assign({}, $1, $2, $3)
    ;

schema_views_or_not
    :
    | schema_views
    ;

schema_entities
    : "entities" NEWLINE INDENT schema_entities_block DEDENT NEWLINE? -> { entities: $4 }
    ;

schema_entities_block
    : identifier_or_string NEWLINE -> [ { entity: $1 } ]
    | identifier_or_string NEWLINE schema_entities_block -> [ { entity: $1 } ].concat($3)
    ;

schema_views
    : "views" NEWLINE INDENT schema_views_block DEDENT NEWLINE? -> { views: $4 }
    ;

schema_views_block
    : identifier_or_string NEWLINE -> [ $1 ]
    | identifier_or_string NEWLINE schema_views_block -> [ $1 ].concat($3)
    ;

type_statement
    : "type" type_statement_item NEWLINE
    | "type" NEWLINE INDENT type_statement_block DEDENT NEWLINE? 
    ;

type_statement_item
    /* 
    there are three kinds of modifiers: validator, processor and activator 
        validator: take subject as the first arg
        processor: take subject as the first arg
        activator: assign value to the subject
        activator should only appear before validator and processor
    */
    : identifier_or_string type_base type_info_or_not type_modifiers_or_not field_comment_or_not
        {            
            if (BUILTIN_TYPES.has($1)) throw new Error('Cannot use built-in type "' + $1 + '" as a custom type name. Line: ' + @1.first_line);
            // default as text
            state.defineType($1, Object.assign({type: 'text'}, $2, $3, $4, $5));
        }
    ;

type_statement_block
    : type_statement_item NEWLINE
    | type_statement_item NEWLINE type_statement_block
    ;

type_base
    : ':' types -> $2
    ;

types
    : int_keyword -> { type: 'integer' }
    | number_keyword -> { type: 'number' }    
    | text_keyword -> { type: 'text' }
    | bool_keyword -> { type: 'boolean' }
    | binary_keyword -> { type: 'binary' }
    | datetime_keyword -> { type: 'datetime' }
    | 'any'  -> { type: 'any' }
    | 'enum' -> { type: 'enum' }
    | 'array' -> { type: 'array' }
    | 'object' -> { type: 'object' }
    | identifier_or_string -> { type: $1 }
    ;

int_keyword
    : 'int'
    | 'integer'
    ;

number_keyword
    : 'number'
    | 'float' 
    | 'decimal'
    ;

text_keyword
    : 'text'
    | 'string'
    ;    

bool_keyword
    : 'bool'
    | 'boolean'
    ;

binary_keyword
    : 'blob'
    | 'binary'
    | 'buffer'
    ;

datetime_keyword
    : 'datetime'
    | 'timestamp'
    ;    

type_info_or_not
    :
    | type_infos
    ;

type_infos
    : type_info
    | type_info type_infos -> Object.assign({}, $1, $2)
    ;

type_info
    : identifier -> { [$1]: true }
    | narrow_function_call -> { [$1.name]: $1.args  }
    ;    

type_modifiers_or_not
    : 
    | type_modifiers -> { modifiers: $1 }
    ;     

type_modifiers
    : type_modifier -> [ $1 ]
    | type_modifier type_modifiers -> [ $1 ].concat($2)
    ;

type_modifier
    : "|~" type_modifier_validators -> $2
    | "|>" identifier -> state.normalizeProcessor($2)
    | "|>" general_function_call -> state.normalizeProcessor($2.name, $2.args)    
    | "|=" "(" literal_and_value_expression ")" -> state.normalizeActivator('$eval', [ $3 ])
    | "|=" identifier -> state.normalizeActivator($2)
    | "|=" general_function_call -> state.normalizeActivator($2.name, $2.args)        
    ;

type_modifier_validators
    : identifier -> state.normalizeValidator($1)
    | general_function_call -> state.normalizeValidator($1.name, $1.args)    
    | REGEXP -> state.normalizeValidator('matches', $1)    
    | "(" logical_expression ")" -> state.normalizeValidator('$eval', [ $2 ])
    ;

entity_statement
    : entity_statement_header NEWLINE -> state.defineEntity($1[0], $1[1], @1.first_line)
    | entity_statement_header NEWLINE INDENT entity_statement_block DEDENT NEWLINE? -> state.defineEntity($1[0], Object.assign({}, $1[1], $4), @1.first_line)
    ;

entity_statement_header
    : entity_statement_header0 -> [ $1, {} ]
    | entity_statement_header0 entity_base_keywords identifier_or_string_list -> [ $1, { base: $3 } ]    
    ;

entity_base_keywords
    : "extends"
    | "is"    
    ;

entity_statement_header0
    : "entity" identifier_or_string -> $2
    ;

entity_statement_block
    : comment_or_not entity_sub_items -> Object.assign({}, $1, $2)
    ;

entity_sub_items
    : entity_sub_item
    | entity_sub_item entity_sub_items -> merge($1, $2)
    ;

entity_sub_item
    : with_features
    | has_fields
    | associations_statement
    | key_statement
    | index_statement
    | data_statement
    | code_statement    
    | interfaces_statement
    | mixin_statement
    | triggers_statement
    | restful_statement
    ;

mixin_statement
    : "mixes" identifier_or_string_list NEWLINE -> { mixins: $2 }
    ;

code_statement
    : "code" identifier_or_string NEWLINE -> { code: $2 }
    ;    

comment_or_not
    :
    | "--" STRING NEWLINE -> { comment: $2 }
    ;

with_features
    : "with" NEWLINE INDENT with_features_block DEDENT NEWLINE? -> { features: $4 }
    ;

with_features_block
    : feature_inject NEWLINE -> [ $1 ]
    | feature_inject NEWLINE with_features_block -> [ $1 ].concat($3)
    ;

has_fields
    : "has" NEWLINE INDENT has_fields_block DEDENT NEWLINE? -> { fields: $4 }
    ;

has_fields_block
    : field_item NEWLINE -> { [$1.name]: $1 }
    | field_item NEWLINE has_fields_block -> Object.assign({}, { [$1.name]: $1 }, $3)
    ;

field_item
    : field_item_body field_comment_or_not -> Object.assign({}, $1, $2)
    ;

field_comment_or_not
    :
    | "--" STRING -> { comment: $2 }
    ;    

field_item_body
    : modifiable_field    
    ;

type_base_or_not
    :
    | type_base
    ;    

associations_statement
    : "associations" NEWLINE INDENT associations_block DEDENT NEWLINE? -> { associations: $4 }
    ;

associations_block
    : association_item NEWLINE -> [ $1 ]
    | association_item NEWLINE associations_block -> [ $1 ].concat($3)
    ;

association_item
    : association_type_referee identifier_or_string (association_through)? (association_as)? type_info_or_not field_comment_or_not -> { type: $1, destEntity: $2, ...$3, ...$4, fieldProps: { ...$5, ...$6} }    
    | association_type_referee NEWLINE INDENT identifier_or_string association_cases_block (association_as)? type_info_or_not field_comment_or_not NEWLINE DEDENT -> { type: $1, destEntity: $4, ...$5, ...$6, fieldProps: { ...$7, ...$8 } }
    | association_type_referer identifier_or_string (association_as)? type_info_or_not type_modifiers_or_not field_comment_or_not -> { type: $1, destEntity: $2, ...$3, fieldProps: { ...$4, ...$5, ...$6 } }      
    ;

association_type_referee
    : "hasOne"
    | "hasMany"
    ;    

association_type_referer
    : "refersTo"
    | "belongsTo"
    ;    

association_through
    : "connectedBy" identifier_string_or_dotname -> { by: $2 }    
    | "connectedBy" identifier_string_or_dotname "with" conditional_expression -> { by: $2, with: $4 }    
    | association_connection -> { remoteField: $1 }     
    | "being" array_of_identifier_or_string -> { remoteField: $2 }      
    | association_condition -> { with: $1 }
    ;

association_cases_block
    : ":" NEWLINE INDENT association_cases DEDENT -> { remoteField: $4 } 
    ;    

association_connection
    : "being" identifier_or_string -> $2
    | "being" identifier_or_string association_condition -> { by: $2, with: $3 }     
    ;

association_cases
    : "when" association_connection NEWLINE -> [ $2 ]
    | "when" association_connection NEWLINE association_cases -> [ $2 ].concat( $4 )
    ;    

association_condition
    : "with" conditional_expression -> $2;
    ;

association_as
    : "as" identifier_or_string -> { srcField: $2 }
    ;

association_qualifiers
    : "optional" -> { optional: true }
    | "default" "(" literal ")" -> { default: $literal }
    ;

/*
hasone_keywords
    : "hasOne"
    | "has" "one"
    ;

hasmany_keywords
    : "hasMany"
    | "has" "one"
    ;    
*/

key_statement
    : "key" identifier_or_string NEWLINE -> { key: $2 }
    | "key" array_of_identifier_or_string NEWLINE -> { key: $2 }
    ;

index_statement
    : "index" index_item NEWLINE -> { indexes: [$2] }
    | "index" NEWLINE INDENT index_statement_block DEDENT NEWLINE? -> { indexes: $4 }
    ;

index_statement_block
    : index_item NEWLINE -> [ $1 ]
    | index_item NEWLINE index_statement_block -> [ $1 ].concat($3)
    ;

index_item
    : index_item_body
    | index_item_body ("is")? "unique" -> Object.assign({}, $1, { unique: true })
    ;

index_item_body
    : identifier_or_string -> { fields: $1 }
    | array_of_identifier_or_string -> { fields: $1 }
    ;

data_statement
    : "data" data_records NEWLINE -> { data: [{ records: $2 }] }
    | "data" identifier_or_string data_records NEWLINE -> { data: [{ dataSet: $2, records: $3 }] }    
    | "data" (identifier_or_string)? "in" identifier_or_string data_records NEWLINE -> { data: [{ dataSet: $2, runtimeEnv: $4, records: $5 }] }    
    ;

data_records
    : inline_object
    | inline_array
    ;    

triggers_statement
    : "triggers" NEWLINE INDENT triggers_statement_block DEDENT NEWLINE? -> { triggers: $4 }
    ;

triggers_operation
    : "onCreate" NEWLINE INDENT triggers_operation_block DEDENT NEWLINE? -> { onCreate: $4 }    
    | "onCreateOrUpdate" NEWLINE INDENT triggers_operation_block DEDENT NEWLINE? -> { onCreateOrUpdate: $4 }   
    | "onDelete" NEWLINE INDENT triggers_operation_block DEDENT NEWLINE? -> { onDelete: $4 }   
    ;

triggers_statement_block
    : triggers_operation -> [ $1 ]
    | triggers_operation triggers_statement_block -> [ $1 ].concat($2)
    ;

triggers_operation_block    
    : triggers_operation_item -> [ $1 ]
    | triggers_operation_item triggers_operation_block -> [ $1 ].concat($2)
    ;

triggers_operation_item
    : "when" conditional_expression NEWLINE INDENT triggers_result_block DEDENT NEWLINE? -> { condition: $2, do: $5 }
    | "always" NEWLINE INDENT triggers_result_block DEDENT NEWLINE? -> { do: $4 }
    ;   

restful_statement
    : "restful" NEWLINE INDENT restful_relative_uri DEDENT NEWLINE? -> { restful: $4 }
    ;

restful_relative_uri    
    : ROUTE NEWLINE INDENT restful_methods DEDENT NEWLINE? -> { [$1]: { type: 'entity', methods: $4 } }
    | ROUTE "->" ROUTE NEWLINE INDENT restful_methods DEDENT NEWLINE? -> { [$1]: { type: 'shortcut', refersTo: $3, methods: $6 } }
    ;

restful_methods
    : restful_method+ -> $1.reduce((r, v) => (Object.assign(r, v), r), {})
    ;

restful_method
    : "create" NEWLINE INDENT restful_create DEDENT NEWLINE? -> { create: $4 }   
    | "findOne" NEWLINE INDENT restful_find_one DEDENT NEWLINE? -> { findOne: $4 }    
    | "findAll" NEWLINE INDENT restful_find_all DEDENT NEWLINE? -> { findAll: $4 }    
    | "updateOne" NEWLINE INDENT restful_update_one DEDENT NEWLINE? -> { updateOne: $4 }    
    | "updateMany" NEWLINE INDENT restful_update_many DEDENT NEWLINE? -> { updateMany: $4 }    
    | "deleteOne" NEWLINE INDENT restful_delete_one DEDENT NEWLINE? -> { deleteOne: $4 }    
    | "deleteMany" NEWLINE INDENT restful_delete_many DEDENT NEWLINE? -> { deleteMany: $4 }
    ;

restful_create
    : restful_create_item* -> $1.reduce((r, v) => (Object.assign(r, v), r), {})
    ;

restful_create_item
    : restful_allow_roles    
    | restful_preset_options
    ;

restful_find_one
    : restful_find_one_item* -> $1.reduce((r, v) => (Object.assign(r, v), r), {})
    ;

restful_find_one_item
    : restful_allow_roles
    | restful_preset_order
    | restful_nested
    | restful_preset_options
    | restful_id_binding
    ;

restful_find_all
    : restful_find_all_item* -> $1.reduce((r, v) => (Object.assign(r, v), r), {})
    ;

restful_find_all_item
    : restful_allow_roles
    | restful_preset_order
    | restful_nested
    | restful_preset_options
    ;    

restful_update_one
    : restful_update_one_item* -> $1.reduce((r, v) => (Object.assign(r, v), r), {})
    ;

restful_update_one_item
    : restful_allow_roles       
    | restful_preset_options
    | restful_id_binding
    ;        

restful_update_many
    : restful_update_many_item* -> $1.reduce((r, v) => (Object.assign(r, v), r), {})
    ;

restful_update_many_item
    : restful_allow_roles     
    | restful_preset_options
    ;        

restful_delete_one
    : restful_delete_one_item* -> $1.reduce((r, v) => (Object.assign(r, v), r), {})
    ;

restful_delete_one_item
    : restful_allow_roles       
    | restful_preset_options
    | restful_id_binding
    ;        

restful_delete_many
    : restful_delete_many_item* -> $1.reduce((r, v) => (Object.assign(r, v), r), {})
    ;

restful_delete_many_item
    : restful_allow_roles        
    | restful_preset_options
    ;        

restful_allow_roles
    : "allow" "anonymous" NEWLINE -> { allowAnonymous: true }  
    | "allow" "self" NEWLINE -> { allowUserSelf: true }     
    | "allow" array_of_identifier_or_string NEWLINE -> { allowedRoles: $2 }     
    ;

restful_preset_order
    : "presetOfOrder" NEWLINE INDENT restful_preset_order_block DEDENT NEWLINE? -> { presetOfOrder: $4 } 
    ;

restful_preset_order_block
    : identifier_or_string inline_object NEWLINE -> { [$1]: $2 }
    | identifier_or_string inline_object NEWLINE restful_preset_order_block -> { [$1]: $2, ...$4 }
    ;     

restful_preset_options
    : "presetOptions" inline_object NEWLINE -> { presetOptions: $2 }
    ;    

restful_nested
    : "nested" NEWLINE INDENT nested_routes+ DEDENT NEWLINE? -> { nested: $4.reduce((r, v) => (Object.assign(r, v), r), {}) }
    ;         

nested_routes
    : ROUTE inline_array inline_object NEWLINE -> { [$1]: { association: $2, query: $3 } }
    | ROUTE inline_array NEWLINE -> { [$1]: { association: $2 } }
    ;   

restful_id_binding
    : "id" modifiable_value NEWLINE -> { bindId: $2 }
    ;   

interfaces_statement
    : "interface" NEWLINE INDENT interfaces_statement_block DEDENT NEWLINE? -> { interfaces: $4 }
    ;

interfaces_statement_block
    : interface_definition -> Object.assign({}, $1)
    | interface_definition interfaces_statement_block -> Object.assign({}, $1, $2)
    ;

interface_definition
    : identifier_or_string NEWLINE INDENT interface_definition_body DEDENT NEWLINE? -> { [$1]: $4 }
    ;

interface_definition_body
    : accept_or_not implementation return_or_not -> Object.assign({}, $1, { implementation: $2 }, $3)
    ;

accept_or_not
    :
    | accept_statement
    ;

accept_statement
    : "accept" accept_param NEWLINE -> { accept: [ $2 ] }
    | "accept" NEWLINE INDENT accept_block DEDENT NEWLINE? -> { accept: $4 }
    ;

accept_block
    : accept_param NEWLINE -> [ $1 ]
    | accept_param NEWLINE accept_block -> [ $1 ].concat($3)
    ;

accept_param
    : modifiable_param
    | identifier_or_string ":" DOTNAME type_info_or_not type_modifiers_or_not -> Object.assign({ name: $1, type: $3 }, $4, $5)   
    ;

implementation
    : operation -> [ $1 ]
    | operation implementation -> [ $1 ].concat($2)
    ;

operation
    : find_one_operation
    | coding_block /*
    | find_list_operation
    | update_operation
    | create_operation
    | delete_operation    
    | assign_operation   */
    ;

find_one_keywords
    : "findOne"
    | "find" article_keyword
    ;

find_one_operation
    : find_one_keywords identifier_or_string selection_inline_keywords conditional_expression -> { oolType: 'FindOneStatement', model: $2, condition: $4 }
    | find_one_keywords identifier_or_string case_statement -> { oolType: 'FindOneStatement', model: $2, condition: $3 }
    ;    

cases_keywords
    : ":"
    | "by" "cases"    
    | "by" "cases" "as" "below"
    ;   

case_statement
    : cases_keywords NEWLINE INDENT case_condition_block DEDENT NEWLINE? -> { oolType: 'cases', items: $4 }
    | cases_keywords NEWLINE INDENT case_condition_block otherwise_statement DEDENT NEWLINE? -> { oolType: 'cases', items: $4, else: $5 } 
    ;

case_condition_item
    : "when" conditional_expression "=>" condition_as_result_expression -> { oolType: 'ConditionalStatement', test: $2, then: $4 }
    ; 

case_condition_block
    : case_condition_item -> [ $1 ]
    | case_condition_item case_condition_block -> [ $1 ].concat($2)
    ;

otherwise_statement
    : otherwise_keywords "=>" condition_as_result_expression NEWLINE -> $3
    | otherwise_keywords "=>" stop_controll_flow_expression NEWLINE -> $3
    | otherwise_keywords "=>" NEWLINE INDENT stop_controll_flow_expression NEWLINE DEDENT -> $5
    ;

otherwise_keywords
    : "otherwise"
    | "else"
    ;          

stop_controll_flow_expression
    : return_expression
    | throw_error_expression
    ;

condition_as_result_expression
    : conditional_expression NEWLINE
    | NEWLINE INDENT conditional_expression NEWLINE DEDENT -> $3
    ;

return_expression
    : "return" modifiable_value -> { oolType: 'ReturnExpression', value: $2 }
    ;

throw_error_expression
    : "throw" STRING -> { oolType: 'ThrowExpression', message: $2 }
    | "throw" identifier -> { oolType: 'ThrowExpression', errorType: $2 }
    | "throw" identifier "(" gfc_param_list  ")" -> { oolType: 'ThrowExpression', errorType: $2, args: $4 }
    ;

return_or_not
    :
    | return_expression NEWLINE
        { $$ = { return: $1 }; }
    | return_expression "unless" NEWLINE INDENT return_condition_block DEDENT NEWLINE? 
        { $$ = { return: Object.assign($1, { exceptions: $5 }) }; }
    ;

return_condition_item
    : "when" conditional_expression "=>" modifiable_value -> { oolType: 'ConditionalStatement', test: $2, then: $4 }    
    | "when" conditional_expression "=>" throw_error_expression -> { oolType: 'ConditionalStatement', test: $2, then: $4 }    
    ;

return_condition_block
    : return_condition_item NEWLINE -> [ $1 ]
    | return_condition_item NEWLINE return_condition_block -> [ $1 ].concat($3)
    ;

update_operation
    : "update" identifier_or_string "with" inline_object where_expr NEWLINE
        { $$ = { oolType: 'update', target: $2, data: $4, filter: $5 }; }
    ;

create_operation
    : "create" identifier_or_string "with" inline_object NEWLINE
        { $$ = { oolType: 'create', target: $2, data: $4 }; }
    ;

delete_operation
    : "delete" identifier_or_string where_expr NEWLINE
        { $$ = { oolType: 'delete', target: $2, filter: $3 }; }
    ;

coding_block
    : "do" javascript NEWLINE -> { oolType: 'DoStatement', do: $2 }
    ;

assign_operation
    : "set" identifier_or_member_access "<-" value variable_modifier_or_not NEWLINE
        { $$ = { oolType: 'assignment', left: $2, right: Object.assign({ argument: $4 }, $5) }; }
    ;

entity_fields_selections
    : identifier_or_string -> { entity: $1 }     
    | identifier_or_string "->" inline_array -> { entity: $1, projection: $3 }
    ;

dataset_statement
    : "dataset" identifier_or_string NEWLINE INDENT dataset_statement_block DEDENT NEWLINE? -> state.defineDataset($2, $5)
    ;

dataset_statement_block
    : "is" article_keyword_or_not dataset_join_with_item -> $3
    ;

dataset_join_with_block
    : dataset_join_with_item -> [ $1 ]
    | dataset_join_with_item dataset_join_with_block -> [ $1 ].concat($2)
    ;

dataset_join_with_item
    : entity_fields_selections NEWLINE -> $1
    | entity_fields_selections "with" ":" NEWLINE INDENT dataset_join_with_block DEDENT NEWLINE? -> { ...$1, with: $6 }
    ;

view_statement
    : "view" identifier_or_string NEWLINE INDENT view_statement_block DEDENT NEWLINE? -> state.defineView($2, $5)
    ;

view_statement_block
    : view_main_entity NEWLINE accept_or_not view_selection_or_not group_by_or_not having_or_not order_by_or_not skip_or_not limit_or_not
        -> Object.assign({}, $1, $3, $4, $5, $6, $7, $8, $9)
    ;

view_main_entity
    : "is" article_keyword_or_not identifier_or_string -> { dataset: $3 }
    | "is" article_keyword_or_not identifier_or_string "list" -> { dataset: $3, isList: true }
    ;

view_selection_or_not
    :
    | view_selection
    ;

view_selection
    : selection_inline_keywords conditional_expression NEWLINE -> { condition: $2 }
    ;

article_keyword_or_not
    :
    | article_keyword
    ;

article_keyword
    : "a"
    | "an"
    | "the"
    | "one"
    ;    

selection_attributive_keywords
    : "of" "which"
    | "where" 
    | "when" 
    | "with"
    ;

selection_keywords
    : "by"
    | "selectedBy"
    | "selected" "by"    
    ;    

selection_inline_keywords
    : selection_keywords
    | selection_attributive_keywords
    ;

group_by_or_not
    :
    | "group" "by" identifier_string_or_dotname_list NEWLINE -> { groupBy: $3 }
    | "group" "by" NEWLINE INDENT identifier_string_or_dotname_block DEDENT NEWLINE? -> { groupBy: $5 }
    ;

having_or_not
    : 
    | "having" conditional_expression NEWLINE -> { having: $2 }
    ;    

order_by_or_not
    :
    | "order" "by" order_by_list NEWLINE -> { orderBy: $3 }
    | "order" "by" NEWLINE INDENT order_by_block DEDENT NEWLINE? -> { orderBy: $5 }
    ;

order_by_block
    : order_by_clause NEWLINE -> [ $1 ]
    | order_by_clause NEWLINE order_by_block -> [ $1 ].concat($3)
    ;

order_by_clause
    : identifier_string_or_dotname -> { field: $1, ascend: true }
    | identifier_string_or_dotname "ascend" -> { field: $1, ascend: true }
    | identifier_string_or_dotname "<" -> { field: $1, ascend: true }
    | identifier_string_or_dotname "descend" -> { field: $1, ascend: false }
    | identifier_string_or_dotname ">" -> { field: $1, ascend: false }
    ;

order_by_list
    : order_by_clause -> [ $1 ]
    | order_by_clause order_by_list0 -> [ $1 ].concat($2)
    ;

order_by_list0
    : "," order_by_clause -> [ $2 ]
    | "," order_by_clause order_by_list0 -> [ $2 ].concat($3)
    ;

skip_or_not
    :
    | "offset" INTEGER NEWLINE -> { offset: $2 }
    | "offset" REFERENCE NEWLINE -> { offset: $2 }
    ;

limit_or_not
    :
    | "limit" INTEGER NEWLINE -> { limit: $2 }
    | "limit" REFERENCE NEWLINE -> { limit: $2 }
    ;

/* A field of entity with a series of modifiers, subject should be identifier or quoted string. */
modifiable_field
    : identifier_or_string type_base_or_not type_info_or_not type_modifiers_or_not -> Object.assign({ name: $1, type: $1 }, $2, $3, $4)   
    ;

/* An argument with a series of modifiers to be used in a function call. */
modifiable_value
    : gfc_param0
    | gfc_param0 type_modifiers -> state.normalizePipedValue($1, { modifiers: $2 })
    ;

/* A parameter declared with a series of modifiers to be used in a function signature. */
modifiable_param
    : modifiable_field
    ; 

feature_inject
    : identifier
    | narrow_function_call
    ;

/* simple function call, without modifiable support */
narrow_function_call
    : identifier "(" nfc_param_list ")" -> { name: $1, args: $3 }
    ;    

nfc_param_list
    : nfc_param -> [ $1 ]
    | nfc_param nfc_param_list0 -> [ $1 ].concat($2)
    ;

nfc_param_list0
    : ',' nfc_param -> [ $2 ]
    | ',' nfc_param nfc_param_list0 -> [ $2 ].concat($3)
    ;    

nfc_param
    : literal
    | identifier -> state.normalizeConstReference($1)
    ;

literal_and_value_expression
    : unary_expression
    | binary_expression
    | boolean_expression    
    ;

general_function_call
    : identifier "(" gfc_param_list ")" -> { name: $1, args: $3 }
    ;        

gfc_param_list
    : modifiable_value -> [ $1 ]    
    | modifiable_value gfc_param_list0 -> [ $1 ].concat($2)    
    ;

gfc_param_list0
    : "," modifiable_value -> [ $2 ]
    | "," modifiable_value gfc_param_list0 -> [ $2 ].concat($3)
    | "," -> []
    ;    

gfc_param0
    : nfc_param
    | REFERENCE
    | REFERENCE "?" -> this.normalizeOptionalReference($1)
    | general_function_call
    ;    

identifier_string_or_dotname
    : identifier
    | STRING
    | DOTNAME
    ;        

identifier_string_or_dotname_block 
    : identifier_string_or_dotname NEWLINE -> [ $1 ]
    | identifier_string_or_dotname NEWLINE identifier_string_or_dotname_block -> [ $1 ].concat($3)
    ;

identifier_string_or_dotname_list
    : identifier_string_or_dotname -> [ $1 ]
    | identifier_string_or_dotname identifier_string_or_dotname_list0 -> [ $1 ].concat($2) 
    ;

identifier_string_or_dotname_list0
    : "," identifier_string_or_dotname -> [ $2 ]
    | "," identifier_string_or_dotname identifier_string_or_dotname_list0 -> [ $2 ].concat($3)
    ;

identifier_or_string
    : identifier
    | STRING
    ;    

identifier
    : NAME
    ;

literal
    : INTEGER
    | FLOAT
    | BOOL
    | inline_object
    | inline_array
    | REGEXP
    | STRING
    | SCRIPT
    | SYMBOL
    ;    

inline_object
    : "{" "}" -> {}
    | "{" kv_pairs "}" -> $2
    ;

kv_pair_item
    : identifier_or_string ":" modifiable_value -> {[$1]: $3}
    | identifier non_exist -> {[$1]: state.normalizeReference($1)}
    | INTEGER ":" modifiable_value -> {[$1]: $3}
    ;

non_exist
    :
    ;

kv_pairs
    : kv_pair_item
    | kv_pair_item kv_pairs0 -> Object.assign({}, $1, $2)
    ;

kv_pairs0
    : "," kv_pair_item -> $2
    | "," kv_pair_item kv_pairs0 -> Object.assign({}, $2, $3)
    ;

inline_array
    : "[" "]" -> []
    | "[" gfc_param_list "]" -> $2
    ;

array_of_identifier_or_string
    : "[" identifier_or_string_list "]" -> $2
    ;

identifier_or_string_list
    : identifier_or_string -> [ $1 ]
    | identifier_or_string identifier_or_string_list0 -> [ $1 ].concat($2)
    ;

identifier_or_string_list0
    : ',' identifier_or_string -> [ $2 ]
    | ',' identifier_or_string identifier_or_string_list0 -> [ $2 ].concat($3)
    ;            

value
    : nfc_param
    | narrow_function_call -> state.normalizeFunctionCall($1)
    ;

conditional_expression
    : simple_expression
    | logical_expression
    | boolean_expression
    ;

simple_expression
    : unary_expression
    | binary_expression
    | "(" simple_expression ")" -> $2
    ;

unary_expression
    : modifiable_value "exists" -> { oolType: 'UnaryExpression', operator: 'exists', argument: $1 }
    | modifiable_value "not" "exists" -> { oolType: 'UnaryExpression', operator: 'not-exists', argument: $1 }
    | modifiable_value "is" "null" -> { oolType: 'UnaryExpression', operator: 'is-null', argument: $1 }
    | modifiable_value "is" "not" "null" -> { oolType: 'UnaryExpression', operator: 'is-not-null', argument: $1 }
    | "not" "(" simple_expression ")" -> { oolType: 'UnaryExpression', operator: 'not', argument: $3, prefix: true }    
    ;

boolean_expression
    : modifiable_value "~" type_modifier_validators -> { oolType: 'ValidateExpression', caller: $1, callee: $3 }    
    | "any" inline_array "~" type_modifier_validators -> { oolType: 'AnyOneOfExpression', caller: $2, callee: $3 }
    | "all" inline_array "~" type_modifier_validators -> { oolType: 'AllOfExpression', caller: $2, callee: $3 }
    ;    

binary_expression
    : modifiable_value ">" modifiable_value -> { oolType: 'BinaryExpression', operator: '>', left: $1, right: $3 }
    | modifiable_value "<" modifiable_value  -> { oolType: 'BinaryExpression', operator: '<', left: $1, right: $3 }
    | modifiable_value ">=" modifiable_value -> { oolType: 'BinaryExpression', operator: '>=', left: $1, right: $3 }
    | modifiable_value "<=" modifiable_value -> { oolType: 'BinaryExpression', operator: '<=', left: $1, right: $3 }
    | modifiable_value "==" modifiable_value -> { oolType: 'BinaryExpression', operator: '==', left: $1, right: $3 }
    | modifiable_value "!=" modifiable_value -> { oolType: 'BinaryExpression', operator: '!=', left: $1, right: $3 }
    | modifiable_value "in" modifiable_value -> { oolType: 'BinaryExpression', operator: 'in', left: $1, right: $3 }
    | modifiable_value "not" "in" modifiable_value -> { oolType: 'BinaryExpression', operator: 'notIn', left: $1, right: $3 }

    | modifiable_value "+" modifiable_value -> { oolType: 'BinaryExpression', operator: '+', left: $1, right: $3 }
    | modifiable_value "-" modifiable_value -> { oolType: 'BinaryExpression', operator: '-', left: $1, right: $3 }
    | modifiable_value "*" modifiable_value -> { oolType: 'BinaryExpression', operator: '*', left: $1, right: $3 }
    | modifiable_value "/" modifiable_value -> { oolType: 'BinaryExpression', operator: '/', left: $1, right: $3 }

    /*| value "is" value
        { $$ = { oolType: 'BinaryExpression', operator: 'is', left: $1, right: $3 }; }    
    | value "like" value
        { $$ = { oolType: 'BinaryExpression', operator: 'like', left: $1, right: $3 }; } */     
    ;        

logical_expression
    : simple_expression logical_expression_right -> Object.assign({ left: $1 }, $2)    
    ;

logical_expression_right
    : logical_operators simple_expression -> Object.assign({ oolType: 'LogicalExpression' }, $1, { right: $2 })
    ;

logical_operators
    : "and" -> { operator: 'and' }
    | "or" -> { operator: 'or' }
    ;

%%