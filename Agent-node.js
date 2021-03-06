/*
 * Copyright (c) 2012 Massachusetts Institute of Technology, Adobe Systems
 * Incorporated, and other contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

/**
 * Your connection to instrumented node code.
 *
 * Provides these events:
 *
 *   - receivedScriptInfo (path):
 *       when information about functions and call sites has been received
 *   - scriptWentAway (path):
 *       when the connection to the instance for a particular path has closed
 */

define(function (require, exports, module) {
    var Agent = require("Agent");

    var _conn;
    var _connected = false;
    var _nodes = {}; // id (string) -> {id: string, path: string, start: {line, column}, end: {line, column}, name: string (optional)}
    var _nodesByFilePath = {};
    var _hitsHandle, _exceptionsHandle;
    var _nodeHitCounts = {};
    var _nodeExceptionCounts = {};
    var _queuedScripts = [];
    var $exports = $(exports);

    function Connection() {
        this.socket = new WebSocket("ws://localhost:8888/");
        this.socket.onerror = this._onerror.bind(this);
        this.socket.onopen = this._onopen.bind(this);
        this.socket.onmessage = this._onmessage.bind(this);
        this.socket.onclose = this._onclose.bind(this);
        this.connected = new $.Deferred();
        this.disconnected = new $.Deferred();
        this._nextRequestIndex = 0;
        this._requests = {};
    }
    Connection.prototype = {
        _onerror: function () {
            this.connected.reject();
            this.disconnected.resolve();
            this._rejectAllPending();
        },
        _onopen: function () {
            this.connected.resolve();
        },
        _onmessage: function (msg) {
            var resp;
            try {
                resp = JSON.parse(msg.data);
            } catch (e) {
                return;
            }

            if (resp.id in this._requests) {
                this._requests[resp.id].resolve(resp.data);
                delete this._requests[resp.id];
            }
        },
        _onclose: function () {
            this.connected.reject();
            this.disconnected.resolve();
            this._rejectAllPending();
        },
        _rejectAllPending: function () {
            for (var i in this._requests) {
                this._requests[i].reject();
            }
            this._requests = {};
        },
        request: function (name, args) {
            var deferred = new $.Deferred();
            var idx = this._nextRequestIndex++;
            this.socket.send(JSON.stringify({
                name: name,
                arguments: args || [],
                id: idx
            }));
            this._requests[idx] = deferred;
            return deferred.promise();
        },
    };

    function _addNodes(nodes) {
        var indexByPath = function (obj, path, hash) {
            if (path in hash) {
                hash[path].push(obj);
            } else {
                hash[path] = [obj];
            }
        }

        for (var i in nodes) {
            var n = nodes[i];
            n.path = n.path.replace(/\\/g, "/"); // XXX: "Windows support"
            _nodes[n.id] = n;
            indexByPath(n, n.path, _nodesByFilePath);
        }

        // de-dup paths, then send receivedScriptInfo event for each one
        var pathsO = {};
        for (var i in nodes) { pathsO[nodes[i].path] = true; }
        for (var path in pathsO) {
            _triggerReceivedScriptInfo(path);
        }
    }

    function _triggerReceivedScriptInfo(path) {
        $exports.triggerHandler("receivedScriptInfo", [path]);
    }

    function _invoke(name, args, callback) {
        _conn.connected.done(function () {
            _conn.request(name, args).done(function (value) {
                callback && callback(value);
            }).fail(function () {
                callback && callback();
            });
        }).fail(function () {
            callback && callback();
        });
    }

    function _reset() {
        _nodes = {};
        _nodesByFilePath = {};
        _hitsHandle = undefined;
        _exceptionsHandle = undefined;
        _nodeHitCounts = {};
        _nodeExceptionCounts = {};
        _queuedScripts = [];
    }

    function _connect() {
        _conn = new Connection();

        _conn.connected.done(function () {
            _connected = true;

            $exports.triggerHandler("connect");

            // get the handle to use for tracking hits
            _invoke("trackHits", [], function (handle) {
                _hitsHandle = handle;
            });

            _invoke("trackExceptions", [], function (handle) {
                _exceptionsHandle = handle;
            });

            // poll for new nodes
            _invoke("trackNodes", [], function (handle) {
                var id = setInterval(function () {
                    _invoke("newNodes", [handle], function (nodes) {
                        if (nodes) {
                            _addNodes(nodes);
                        }
                    });
                }, 1000);

                _conn.disconnected.done(function () {
                    clearInterval(id);
                });
            });
        });
        _conn.disconnected.done(function () {
            if (_connected) $exports.triggerHandler("disconnect");

            _connected = false;

            var paths = [];
            for (var path in _nodesByFilePath) {
                paths.push(path);
            }

            _reset();

            paths.forEach(function (path) {
                $exports.triggerHandler("scriptWentAway", path);
            });

            setTimeout(_connect, 1000);
        });
    }

    function init() {
        _connect();
    }

    function isReady() {
        return _connected;
    }

    function functionWithId(fid) {
        return _nodes[fid];
    }

    function functionsInFile(path) {
        var possibleRemotePaths = Agent.possibleRemotePathsForLocalPath(path);
        for (var i in possibleRemotePaths) {
            var nodes = _nodesByFilePath[possibleRemotePaths[i]];
            if (nodes) {
                return nodes.filter(function (n) { return n.type === "function" });
            }
        }
        return [];
    }

    function refreshHitCounts(callback) {
        if (_hitsHandle === undefined) {
            callback && callback();
            return;
        }

        _invoke("hitCountDeltas", [_hitsHandle], function (deltas) {
            if (deltas) {
                for (var id in deltas) {
                    _nodeHitCounts[id] = (_nodeHitCounts[id] || 0) + deltas[id];
                }
                callback && callback(_nodeHitCounts, deltas);
            } else {
                callback && callback(_nodeHitCounts, {});
            }
        });
    }

    function refreshExceptionCounts(callback) {
        if (_exceptionsHandle === undefined) {
            callback && callback();
            return;
        }

        _invoke("newExceptions", [_exceptionsHandle], function (exceptions) {
            if (exceptions) {
                for (var id in exceptions.counts) {
                    _nodeExceptionCounts[id] = (_nodeExceptionCounts[id] || 0) + exceptions.counts[id];
                }
                callback && callback(_nodeExceptionCounts, exceptions.counts);
            } else {
                callback && callback(_nodeExceptionCounts, {});
            }
        });
    }

    function cachedHitCounts() {
        return _nodeHitCounts;
    }

    function trackLogs(query, callback) {
        _invoke("trackLogs", [query], callback);
    }

    function refreshLogs(handle, maxResults, callback) {
        _invoke("logDelta", [handle, maxResults], function (results) {
            if (results) {
                results.forEach(function (entry) {
                    entry.source = "node";
                });
            }
            callback(results);
        });
    }

    function backtrace(options, callback) {
        _invoke("backtrace", [options], function (backtrace) {
            if (backtrace) {
                backtrace.forEach(function (entry) {
                    entry.source = "node";
                });
                callback(backtrace);
            } else {
                callback();
            }
        });
    }

    exports.init = init;
    exports.isReady = isReady;

    // satisfied from locally cached data (sync)
    exports.functionWithId = functionWithId;
    exports.functionsInFile = functionsInFile;
    exports.cachedHitCounts = cachedHitCounts;

    // fetch data from the instrumented app (async)
    exports.refreshHitCounts = refreshHitCounts;
    exports.refreshExceptionCounts = refreshExceptionCounts;
    exports.trackLogs = trackLogs;
    exports.refreshLogs = refreshLogs;
    exports.backtrace = backtrace;
});
