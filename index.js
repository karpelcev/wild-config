/* eslint no-console: 0, global-require: 0 */
'use strict';

const EventEmitter = require('events');
const env = (process.env.NODE_ENV || '').toString().toLowerCase().replace(/[^0-9a-z-_]/g, '') || 'development';
const fs = require('fs');
const toml = require('toml');
const path = require('path');
const deepExtend = require('deep-extend');
const configDirectory = process.env.NODE_CONFIG_DIR || path.join(process.cwd(), 'config');
const events = new EventEmitter();
const vm = require('vm');

const argv = require('minimist')(process.argv.slice(2));
const configPath = argv.config || argv.c || false;

module.exports = {};

let loadConfig = skipEvent => {
    let sources = [{}];

    function extendToml(basePath, contents) {
        // # @include "/path/to/toml"
        let c = 0;
        return contents.replace(/^\s*#\s*@include\s*"([^"]+)"/gim, (m, p) => {
            if (!path.isAbsolute(p)) {
                p = path.join(basePath, p);
            }
            let res = m;
            try {
                let stat = fs.statSync(p);

                if (!stat.isFile()) {
                    throw new Error(p + ' is not a file');
                }
                res = '__include_file_path_' + ++c + '=' + JSON.stringify(p);
            } catch (E) {
                // ignore
            }
            return res;
        });
    }

    function parseFile(filePath) {
        let pathParts = path.parse(filePath);
        let ext = pathParts.ext.toLowerCase();
        let basePath = pathParts.dir;

        let stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            throw new Error(filePath + ' is not a file');
        }
        let parsed;
        try {
            let contents = fs.readFileSync(filePath, 'utf-8');

            switch (ext) {
                case '.js': {
                    let script = new vm.Script(contents);
                    const sandbox = {
                        require,
                        __dirname: basePath,
                        __filename: filePath,
                        module: {
                            exports: {}
                        }
                    };
                    script.runInNewContext(sandbox);
                    parsed = sandbox.module.exports;
                    break;
                }
                case '.toml':
                    parsed = tomlParser(basePath, contents);
                    break;
                case '.json':
                    parsed = JSON.parse(contents);
                    break;
            }
        } catch (E) {
            E.message = filePath + ': ' + E.message;
            throw E;
        }
        return parsed;
    }

    function tomlParser(basePath, contents) {
        let parsed = toml.parse(extendToml(basePath, contents));
        // find includes
        let walk = (node, parentNode, nodeKey, level) => {
            if (level > 100) {
                throw new Error('Too much nesting in configuration file');
            }

            if (Array.isArray(node)) {
                node.forEach(entry => walk(entry, node, false, level + 1));
            } else if (node && typeof node === 'object') {
                Object.keys(node || {}).forEach(key => {
                    if (/^__include_file_path_\d+$/.test(key) && typeof node[key] === 'string') {
                        let parsed = parseFile(node[key]);
                        delete node[key];
                        if (Array.isArray(parsed)) {
                            if (parentNode && nodeKey && Object.keys(node).length === 0) {
                                parentNode[nodeKey] = parsed;
                            }
                        } else {
                            Object.keys(parsed || {}).forEach(subKey => {
                                node[subKey] = parsed[subKey];
                            });
                        }
                    } else if (node[key] && typeof node[key] === 'object') {
                        walk(node[key], node, key, level + 1);
                    }
                });
            }
        };

        walk(parsed, false, false, 0);

        return parsed;
    }

    let loadFromFile = (filePath, ignoreMissing) => {
        if (!filePath) {
            // do nothing
            return;
        }
        try {
            let parsed = parseFile(filePath);
            if (parsed) {
                sources.push(parsed);
            }
        } catch (E) {
            if (E.code !== 'ENOENT' || !ignoreMissing) {
                // file missing, ignore
                console.error('[' + filePath + '] ' + E.message);
                process.exit(1);
            }
        }
    };

    try {
        let listing = fs.readdirSync(configDirectory);
        listing
            .map(file => ({
                name: file,
                isDefault: file.toLowerCase().indexOf('default.') === 0,
                path: path.join(configDirectory, file)
            }))
            .filter(file => {
                let parts = path.parse(file.name);
                if (!['.toml', '.json', '.js'].includes(parts.ext.toLowerCase())) {
                    return false;
                }
                if (!['default', env].includes(parts.name.toLowerCase())) {
                    return false;
                }
                return true;
            })
            .sort((a, b) => {
                if (a.isDefault) {
                    return -1;
                }
                if (b.isDefault) {
                    return 1;
                }
                return a.path.localeCompare(b.path);
            })
            .forEach(file => loadFromFile(file.path));
    } catch (E) {
        // failed to list files
    }

    // try user specified file
    loadFromFile(configPath);

    // join found files
    let data = deepExtend(...sources);

    // apply command line options
    // only modifies keys that already exist
    Object.keys(argv).forEach(key => {
        if (key === '_' || key === 'config' || key === 'c') {
            return;
        }
        let value = argv[key];
        let kPath = key.replace(/\.+/g, '.').replace(/^\.|\.$/g, '').trim().split('.');

        let ignore = false;
        let parent = data;
        let eKey = kPath.pop();
        kPath.forEach(k => {
            if (ignore) {
                return;
            }
            if (parent[k] && typeof parent[k] === 'object' && !Array.isArray(parent[k])) {
                parent = parent[k];
            }
        });
        if (ignore) {
            return;
        }
        if (eKey in parent) {
            if (typeof parent[eKey] === 'number' && !isNaN(value)) {
                parent[eKey] = Number(value);
            } else if (typeof parent[eKey] === 'boolean') {
                if (!isNaN(value)) {
                    value = Number(value);
                } else {
                    value = value.toLowerCase();
                }
                let falsy = ['false', 'null', 'undefined', 'no', '0', '', 0];
                parent[eKey] = falsy.includes(value) ? false : !!value;
            } else {
                parent[eKey] = value;
            }
        }
    });

    Object.keys(data).forEach(key => {
        if (key !== 'on') {
            module.exports[key] = data[key];
        }
    });

    if (!skipEvent) {
        events.emit('reload');
    }
};
events.reload = loadConfig;

Object.defineProperty(module.exports, 'on', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: (...args) => events.on(...args)
});

process.on('SIGHUP', () => {
    setImmediate(loadConfig);
});

loadConfig(true);
