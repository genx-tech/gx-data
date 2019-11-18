module.exports = function (api) {  
  let isProduction = api.env(["production"]); 

  return {
    "env": {
      "development": {
        "sourceMaps": "inline",
        "plugins": ["source-map-support"]
      },
      "test": {
        "sourceMaps": true
      },
      "production": {
        "minified": true        
      }
    },
    "comments": false,
    "presets": [
      [
        "@babel/env",
        {      
          "targets": {     
            "node": "8.11.4"
          }
        }
      ]
    ],
    "ignore": [
      "node_modules",
      "src/**/*.spec.js",
      "src/lang/grammar/oolong.js",
      "src/lang/grammar/test.js"
    ], 
    "plugins": [
      ["contract", {
        "strip": isProduction,
        "names": {
          "assert": "assert",
          "precondition": "pre",
          "postcondition": "post",
          "invariant": "invariant",
          "return": "it"
        }
      }],      
      ["@babel/plugin-proposal-decorators", {"legacy": true}],
      ["@babel/plugin-proposal-class-properties", { "loose": true }]
    ]
  };
}