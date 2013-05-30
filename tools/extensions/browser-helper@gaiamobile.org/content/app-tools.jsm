const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

const EXPORTED_SYMBOLS = [];

/**
 * This module register AppsActor that will fire `webappsOpen` event
 * whenener we change the current displayed app (also fire an event when we
 * go back to homescreen)
 * This actor also expose a listApps method to fetch all apps that are being
 * tracked. (It won't list apps being opened before we instanciated the actor)
 * (This actor is instanciated when we call {root actor}.listTabs)
 * This actor exposes AppActor instances that inherits from BrowserTabActor
 * and are meant to be passed to TabTarget as target actor.
 *
 * This module listen for Gaia events being fired in the current tab.
 * And query these apps actors in order to automatically open a remote toolbox
 * whenever we change app.
 **/
Cu.import('resource://gre/modules/Services.jsm');


// devtools and Toolbox doesn't seem to be exposed, so steal them from gDevTools global
const { devtools, Toolbox } = Cu.import('resource:///modules/devtools/gDevTools.jsm');
Cu.import("resource:///modules/devtools/shared/event-emitter.js");

const { gGlobal } = Cu.import('resource://gre/modules/devtools/dbg-server.jsm');
// ActorPool doesn't seem to be exposed, so steal it from dbg-server private objects
const { ActorPool } = gGlobal;
if (!DebuggerServer.initialized) {
  DebuggerServer.init();
  DebuggerServer.addBrowserActors();
}
// Same thing for BrowserTabActor... but we have to wait for browser actors
// to be registered before fetching him from DebuggerServer
const { BrowserTabActor } = DebuggerServer;

Cu.import("resource://gre/modules/devtools/dbg-client.jsm");

function AppsActor(aConnection) {
  let self = this;
  this._appsActorPool = new ActorPool(aConnection);
  aConnection.addActorPool(this._appsActorPool);
  let browserWindow = Services.wm.getMostRecentWindow('navigator:browser');
  function watchDocument(window) {
    Cu.reportError("##################### Watch > "+window+" / "+window.location);
    if (window.wrappedJSObject)
      window = window.wrappedJSObject;
    window.addEventListener("appwillopen", function (event) {
      Cu.reportError("##################### FOREGROUND");
      let origin = event.detail.origin;
      Cu.reportError("Appwillopen: " + origin + "/"+event.target+"/"+event.target.contentWindow+"/"+event.target.contentWindow.location);
      // First ensure that we do not already have an actor for this app
      let actor = self.getActorWithOrigin(origin);
      if (!actor) {
        // Otherwise, create an actor for the current app
        // We should pass the <iframe> in order to avoid trigering bug 863818's workaround :/
        actor = new AppActor(self.conn, event.target, origin);
        self._appsActorPool.addActor(actor);
      }
      self.conn.send({ from: self.actorID,
                       type: "webappsOpen",
                       actor: actor.grip(),
                       origin: origin
                     });
    });
    window.addEventListener("appopen", function (event) {
      let origin = event.detail.origin;
      Cu.reportError("Appopen: "+origin);
    });
    window.addEventListener("appterminated", function (event) {
      let origin = event.detail.origin;
      let actor = self.getActorWithOrigin(origin);
      if (actor) {
        self._appsActorPool.removeActor(actor);
      }
      let toolbox = toolboxes.get(origin);
      if (toolbox)
        toobox.destroy();
    });
  }
  
  function watchBrowser(browser) {
    Cu.reportError("######### set listener on:" + browser.tagName);
    function onContentLoad(event) {
      Cu.reportError("######### Oncontentload");
      let window = event.target;
      watchDocument(window);
    }
    browser.addEventListener("DOMContentLoaded", onContentLoad, true);
    if (browser.contentWindow.document.readyState == "complete")
      watchDocument(browser.contentWindow);
  }
  browserWindow.addEventListener("TabOpen", function (event) {
    let tab = event.target;
    watchBrowser(tab.linkedBrowser);
  });
  watchBrowser(browserWindow.gBrowser.mCurrentBrowser);
}
AppsActor.prototype = {
  actorID: "apps",
  getActorWithOrigin: function(origin) {
    for (let name in this._appsActorPool._actors) {
      let actor = this._appsActorPool._actors[name];
      if (actor.origin == origin) {
        return actor;
      }
    }
    return null;
  },
  onListApps: function () {
    let actors = [];
    for (let name in this._appsActorPool._actors) {
      let actor = this._appsActorPool._actors[name];
      if (actor)
        actors.push(actor.grip());
    }
    return {
      actors: actors
    };
  }
};
AppsActor.prototype.requestTypes = {
  "listApps": AppsActor.prototype.onListApps
};
DebuggerServer.addGlobalActor(AppsActor, "apps");

function AppActor(connection, browser, origin) {
  BrowserTabActor.call(this, connection, browser);
  this.origin = origin;
}
AppActor.prototype = new BrowserTabActor();
Object.defineProperty(AppActor.prototype, "title", {
  get: function() {
    return this.browser.contentWindow.title;
  },
  enumerable: true,
  configurable: false
});
Object.defineProperty(AppActor.prototype, "url", {
  get: function() {
    return this.browser.contentWindow.document.documentURI;
  },
  enumerable: true,
  configurable: false
});
Object.defineProperty(AppActor.prototype, "contentWindow", {
  get: function() {
    return this.browser.contentWindow;
  },
  enumerable: true,
  configurable: false
});


let client = new DebuggerClient(DebuggerServer.connectPipe());
client.connect(function () {
  // Call list tabs mostly to register and instanciate apps actor
  client.listTabs(function(aResponse) {
    let packet = {
      to: aResponse.apps,
      type: "listApps"
    };
    client.request(packet, function(aResponse) {
      Cu.reportError("client request: " + aResponse);
      Cu.reportError("form " + aResponse.actors.length);
    });
  });
});
let toolboxes = new Map();
let currentToolbox;
client.addListener("webappsOpen", function(aState, aType, aPacket) {
  Cu.reportError("webappsOpen "+aType.origin);
  if (currentToolbox) {
    currentToolbox.frame.style.display = "none";
  }
  let toolbox = toolboxes.get(aType.origin);
  if (toolbox) {
    toolbox.frame.style.display = "block";
    currentToolbox = toolbox;
  } else {
    Cu.reportError("#### CREATE TOOLBOX for "+aType.origin);
    Cu.reportError("### "+aType.actor);
    let options = {
      form: aType.actor,
      client: client,
      chrome: false
    };
    devtools.TargetFactory.forRemoteTab(options).then((target) => {
      // We have to set tab as BottomHost expect a tab attribute on target
      // whereas TabTarget ignores any tab being given as options attributes passed by forRemoteTab.
      let browserWindow = Services.wm.getMostRecentWindow('navigator:browser');
      Object.defineProperty(target, "tab", {value: browserWindow.gBrowser.selectedTab});
      let promise = gDevTools.showToolbox(target, "webconsole", devtools.Toolbox.HostType.BOTTOM);
      promise.then(function (toolbox) {
        currentToolbox = toolbox;
        toolboxes.set(aType.origin, toolbox);
      });
    });    
  }
});
