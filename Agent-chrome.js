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
 * Your connection to the browser-side instrumentation code.
 *
 * Provides these events:
 *
 *   - receivedScriptInfo (path):
 *       when information about functions and call sites has been received
 */

define(function (require, exports, module) {
    var Agent                = require("Agent");
    var AppInit              = brackets.getModule("utils/AppInit");
    var DOMAgent             = brackets.getModule("LiveDevelopment/Agents/DOMAgent");
    var ExtensionUtils       = brackets.getModule("utils/ExtensionUtils");
    var Fsm                  = require("fsm").Fsm;
    var Inspector            = brackets.getModule("LiveDevelopment/Inspector/Inspector");
    var LiveDevServerManager = brackets.getModule("LiveDevelopment/LiveDevServerManager");
    var NodeConnection       = brackets.getModule("utils/NodeConnection");
    var ProjectManager       = brackets.getModule("project/ProjectManager");
    var Util                 = require("Util");
    var main                 = require("main");

    var $exports = $(exports);

    var _proxyURL;
    var _tracerObjectId;
    var _defaultTrackingHandle, _defaultExceptionTrackingHandle;
    var _queuedScripts;
    var _proxyServerProvider;

    /**
     * @private
     * @type{jQuery.Deferred.<NodeConnection>}
     * A deferred which is resolved with a NodeConnection or rejected if
     * we are unable to connect to Node.
     */
    var _nodeConnectionDeferred = $.Deferred();

    /**
     * @const
     * Amount of time to wait before automatically rejecting the connection
     * deferred. If we hit this timeout, we'll never have a node connection
     * for the static server in this run of Brackets.
     */
    var NODE_CONNECTION_TIMEOUT = 30000; // 30 seconds

    // instrumentation data
    var _nodes = {}; // id (string) -> {id: string, path: string, start: {line, column}, end: {line, column}, name: string (optional)}
    var _nodesByFilePath = {};
    var _invocations = {}; // id (string) -> {id: string, f: function (see above), children: [invocation id], parents: [invocation id]}
    var _nodeHitCounts = {};
    var _nodeExceptionCounts = {};

    var fsm = new Fsm({
        waitingForApp: {
            appReady:              function () { _resetAll(); _startProxy(); this.goto("disconnected"); },
        },
        disconnected: {
            enter:                 function () { _resetConnection(); },
            inspectorConnected:    function () { this.goto("waitingForPage"); },
        },
        waitingForPage: {
            enter:                 function () { _resetConnection(); },
            gotDocument:           function () { this.goto("initializingTracer"); },
            inspectorDisconnected: function () { this.goto("disconnected"); },
        },
        initializingTracer: {
            enter:                 function () { _resetConnection(); _connectToTracer(); },
            tracerConnected:       function () { this.goto("initializingHits"); },
            tracerConnectFailed:   function () { this.goto("waitingForPage"); },

            gotDocument:           function () { this.goto("initializingTracer"); }, // XXX: I think this case is tricky
            inspectorDisconnected: function () { this.goto("disconnected"); },
        },
        initializingHits: {
            enter:                 function () { _trackHits(); },
            trackingHits:          function () { this.goto("initializingExceptions"); },
            trackingHitsFailed:    function () { this.goto("disconnected"); },

            gotDocument:           function () { this.goto("initializingTracer"); }, // XXX: I think this case is tricky
            inspectorDisconnected: function () { this.goto("disconnected"); },
        },
        initializingExceptions: {
            enter:                 function () { _trackExceptions(); },
            trackingExceptions:    function () { this.goto("connected"); },
            trackingExceptionsFailed: function () { this.goto("disconnected"); },

            gotDocument:           function () { this.goto("initializingTracer"); }, // XXX: I think this case is tricky
            inspectorDisconnected: function () { this.goto("disconnected"); },
        },
        connected: {
            enter:                 function () { $exports.triggerHandler("connect"); _sendQueuedEvents(); },
            exit:                  function () { _onDisconnect(); },

            gotDocument:           function () { this.goto("initializingTracer"); },
            inspectorDisconnected: function () { this.goto("disconnected"); },
        },
    }, "waitingForApp");

    function ProxyServerProvider() {
    }
    ProxyServerProvider.prototype = {
        canServe: function (localPath) {
            return main.isEnabled() && fsm.state !== "waitingForApp";
        },

        readyToServe: function () {
            var readyToServeDeferred = $.Deferred();

            _nodeConnectionDeferred.done(function (nodeConnection) {
                if (nodeConnection.connected()) {
                    nodeConnection.domains.theseusServer.getServer(
                        ProjectManager.getProjectRoot().fullPath,
                        main.getModeName()
                    ).done(function (address) {
                        _proxyURL = "http://" + address.address + ":" + address.port + "/";
                        readyToServeDeferred.resolve();
                    }).fail(function () {
                        _proxyURL = undefined;
                        readyToServeDeferred.reject();
                    });
                } else {
                    // nodeConnection has been connected once (because the deferred
                    // resolved, but is not currently connected).
                    //
                    // If we are in this case, then the node process has crashed
                    // and is in the process of restarting. Once that happens, the
                    // node connection will automatically reconnect and reload the
                    // domain. Unfortunately, we don't have any promise to wait on
                    // to know when that happens. The best we can do is reject this
                    // readyToServe so that the user gets an error message to try
                    // again later.
                    //
                    // The user will get the error immediately in this state, and
                    // the new node process should start up in a matter of seconds
                    // (assuming there isn't a more widespread error). So, asking
                    // them to retry in a second is reasonable.
                    readyToServeDeferred.reject();
                }
            });

            _nodeConnectionDeferred.fail(function () {
                readyToServeDeferred.reject();
            });

            return readyToServeDeferred.promise();
        },

        getBaseUrl: function () {
            return _proxyURL;
        },
    };

    function _startProxy() {
        _proxyServerProvider = new ProxyServerProvider;
        LiveDevServerManager.registerProvider(_proxyServerProvider, 10);

        // initialize Node connection
        var connectionTimeout = setTimeout(function () {
            console.error("[StaticServer] Timed out while trying to connect to node");
            _nodeConnectionDeferred.reject();
        }, NODE_CONNECTION_TIMEOUT);

        var nodeConnection = new NodeConnection();
        nodeConnection.connect(true).then(function () {
            nodeConnection.loadDomains(
                [ExtensionUtils.getModulePath(module, "proxy/ProxyDomain")],
                true
            ).then(
                function () {
                    clearTimeout(connectionTimeout);
                    _nodeConnectionDeferred.resolveWith(null, [nodeConnection]);
                },
                function () { // Failed to connect
                    console.error("[StaticServer] Failed to connect to node", arguments);
                    _nodeConnectionDeferred.reject();
                }
            );
        });
    }

    /** event handler for when a new page is loaded **/
    function _gotDocument(e, res) {
        fsm.trigger("gotDocument");
    }

    function _connectToTracer() {
        Inspector.Runtime.evaluate("tracer.connect()", function (res) {
            if (!res.wasThrown) {
                _tracerObjectId = res.result.objectId;
                fsm.trigger("tracerConnected");
            } else {
                console.log("failed to get tracer instance", res);
                fsm.trigger("tracerConnectFailed");
            }
        });
    }

    function _trackHits() {
        trackHits(function (handle) {
            if (handle === undefined) {
                fsm.trigger("trackingHitsFailed");
            } else {
                _defaultTrackingHandle = handle;
                fsm.trigger("trackingHits");
            }
        });
    }

    function _trackExceptions() {
        trackExceptions(function (handle) {
            if (handle === undefined) {
                fsm.trigger("trackingExceptionsFailed");
            } else {
                _defaultExceptionTrackingHandle = handle;
                fsm.trigger("trackingExceptions");
            }
        });
    }

    function _onDisconnect() {
        $exports.triggerHandler("disconnect");

        var paths = [];
        for (var path in _nodesByFilePath) {
            paths.push(path);
        }

        _resetConnection(); // note: this will happen again when we enter the disconnected state

        // only fire this event after the connection has been reset
        // since the UI will immediately ask for the new set of functions in the open file
        paths.forEach(function (path) {
            $exports.triggerHandler("scriptWentAway", path);
        });
    }

    /**
     * WebInspector event: DOM.attributeModified
     *
     * The page sends Brackets events by putting message data into DOM
     * attributes whose names match the pattern data-tracer-*
     *
     * @param res is an object with keys nodeId, name, and value
     */
    function _onAttributeModified(event, res) {
        if (res.name === 'data-tracer-scripts-added') {
            var data = JSON.parse(res.value);
            _addNodes(data.nodes);

            // de-dup paths, then send receivedScriptInfo event for each one
            var pathsO = {};
            for (var i in data.nodes) { pathsO[data.nodes[i].path] = true; }
            for (var path in pathsO) {
                _triggerReceivedScriptInfo(path);
            }
        }
    }

    function _triggerReceivedScriptInfo(path) {
        if (isReady()) {
            $exports.triggerHandler("receivedScriptInfo", [path]);
        } else {
            _queuedScripts.push(path);
        }
    }

    function _sendQueuedEvents() {
        _queuedScripts.forEach(function (path) {
            $exports.triggerHandler("receivedScriptInfo", [path]);
        });
        _queuedScripts = [];
    }

    /**
     * Called when the browser loads new code and sends us a scripts-added event
     *
     * @param {array of functions} functions
     * @param {array of call sites} callSites
     */
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
            _nodes[n.id] = n;
            indexByPath(n, n.path, _nodesByFilePath);
        }
    }

    function _setInspectorCallbacks() {
        Inspector.Page.enable();
        $(DOMAgent).on("getDocument", _gotDocument);
        $(Inspector.DOM).on("attributeModified", _onAttributeModified);

        // AJAX testing

        // Inspector.Debugger.enable();
        // Inspector.Debugger.setBreakpointsActive(true);
        // Inspector.DOMDebugger.setXHRBreakpoint("");
        // $(Inspector.Debugger).on("paused", function (jqev, ev) {
        //     console.log("XHR breakpoint", ev.callFrames, ev.data, ev.data.url);
        //     Inspector.Runtime.getProperties(ev.callFrames[0].this.objectId, function () {
        //         console.log("got properties", arguments, arguments[0].result.map(function (o) { return o.name }));
        //         Inspector.Debugger.resume();
        //     });
        // });
        // Inspector.Network.enable();
        // $(Inspector.Network).on("responseReceived", function () {
        //     console.log("Network responseReceived", arguments);
        // });
    }

    function _clearInspectorCallbacks() {
        $(DOMAgent).off("getDocument", _gotDocument);
        $(Inspector.DOM).off("attributeModified", _onAttributeModified);
    }

    function _resetAll() {
        _proxyURL = undefined;
        _resetConnection();
    }

    function _resetConnection() {
        _tracerObjectId = undefined;
        _defaultTrackingHandle = undefined;
        _defaultExceptionTrackingHandle = undefined;
        _queuedScripts = [];
        _nodes = {};
        _nodesByFilePath = {};
        _invocations = {};
        _nodeHitCounts = {};
        _nodeExceptionCounts = {};
    }

    /**
     * functionName is the name of the property of the tracer to invoke
     * args is an array of arguments fit for passing to Inspector.Runtime.callFunctionOn
     * callback will be called with either the result value, or no arguments if there was an error
     * TODO: the first argument to the callback should be err, dude
     */
    function _invoke(functionName, args, callback) {
        if (["initializingTracer", "initializingHits", "initializingExceptions", "connected"].indexOf(fsm.state) !== -1) {
            Inspector.Runtime.callFunctionOn(_tracerObjectId, "tracer." + functionName, args, true, true, function (res) {
                if (!res.wasThrown) {
                    callback && callback(res.result.value);
                } else {
                    console.log('Inspector.Runtime.callFunctionOn exception', res);
                    callback && callback();
                }
            });
        } else {
            callback && callback();
        }
    }

    /**
     * like $.grep, but iterates over the values in an object instead of a
     * collection
     */
    function _objectValueGrep(obj, filter) {
        var results = [];
        for (var i in obj) {
            if (filter(obj[i], i)) {
                results.push(obj[i]);
            }
        }
        return results;
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

    function cachedHitCounts() {
        return _nodeHitCounts;
    }

    function trackHits(callback) {
        _invoke("trackHits", [], callback);
    }

    function trackExceptions(callback) {
        _invoke("trackExceptions", [], callback);
    }

    /**
     * callback will get 2 arguments: hitCounts, and deltas
     * both of the form { functions: {fid -> count}, callSites: {fid -> count} }
     * (they point to internal storage, so please don't modify)
     */
    function refreshHitCounts(callback) {
        _invoke("hitCountDeltas", [{ value: _defaultTrackingHandle }], function (deltas) {
            if (deltas) {
                for (var id in deltas) {
                    _nodeHitCounts[id] = (_nodeHitCounts[id] || 0) + deltas[id];
                }
                callback(_nodeHitCounts, deltas);
            } else {
                callback();
            }
        });
    }

    function refreshExceptionCounts(callback) {
        _invoke("newExceptions", [{ value: _defaultExceptionTrackingHandle }], function (exceptions) {
            if (exceptions) {
                for (var id in exceptions.counts) {
                    _nodeExceptionCounts[id] = (_nodeExceptionCounts[id] || 0) + exceptions.counts[id];
                }
                callback(_nodeExceptionCounts, exceptions.counts);
            } else {
                callback();
            }
        });
    }

    function trackLogs(query, callback) {
        _invoke("trackLogs", [{ value: query }], callback);
    }

    function refreshLogs(handle, maxResults, callback) {
        _invoke("logDelta", [{ value: handle }, { value: maxResults }], function (results) {
            if (results) {
                results.forEach(function (entry) {
                    entry.source = "chrome";
                });
            }
            callback(results);
        });
    }

    function backtrace(options, callback) {
        _invoke("backtrace", [{ value: options }], function (backtrace) {
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

    function isReady() {
        return fsm.state === "connected";
    }

    function init() {
        Inspector.on("connect", function () {
            _setInspectorCallbacks();
            fsm.trigger("inspectorConnected");
        });
        Inspector.on("disconnect", function () {
            _clearInspectorCallbacks();
            fsm.trigger("inspectorDisconnected");
        });
    }

    AppInit.appReady(function () { fsm.trigger("appReady"); });

    // exports
    exports.init = init;
    exports.isReady = isReady;

    // satisfied from locally cached data
    // (read-only once received from browser)
    exports.functionWithId = functionWithId;
    exports.functionsInFile = functionsInFile;

    // fetch data from the browser
    exports.trackHits = trackHits;
    exports.refreshHitCounts = refreshHitCounts;
    exports.refreshExceptionCounts = refreshExceptionCounts;
    exports.cachedHitCounts = cachedHitCounts;
    exports.trackLogs = trackLogs;
    exports.refreshLogs = refreshLogs;
    exports.backtrace = backtrace;
});
