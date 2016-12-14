/*
TODO:
 [root@engine engine-config]# engine-config -s CORSSupport=true
 [root@engine engine-config]# engine-config -s 'CORSAllowedOrigins=*' # or more particular

  ovirt-engine: CORS filter: use dynamic list of hosts

 replace in manifest.json: "content-security-policy": "default-src * 'unsafe-inline' 'unsafe-eval';connect-src https://engine.local;"
    connect-src 'self';   -->   connect-src [ENGINE_URL];
    implement check here in provider about content of cockpit/machines/manifest.json -- reinstallation
       - maybe script updating it, rpm|user can call it

 encoded url:
 https://engine.local/ovirt-engine/web-ui/authorizedRedirect.jsp?redirectUrl=https://192.168.122.101:9090/machines__hash__token=TOKEN

 check error status code: 401 - remove token and reissue login
 */

/*
 To have this external provider working, the oVirt SSO token must be provided to the cockpit/machines plugin.
 Parameters to cockpit packages can't be provided via '?' in the URL, so the hash '#' sign is used as workaround.
 Example:
    https://[ENGINE_HOST]/ovirt-engine/web-ui/authorizedRedirect.jsp?redirectUrl=https://[COCKPI_HOST]:9090/machines__hash__token=TOKEN
 */

var _ = function (str) { return str; } // TODO: implement localization

function logDebug (msg) {
  if (OVIRT_PROVIDER.CONFIG.debug) {
    console.log('OVIRT_PROVIDER: ' + msg);
  }
}

function logError (msg) {
  console.error('OVIRT_PROVIDER: ' + msg);
}

var OVIRT_PROVIDER = {
  name: 'oVirt',
  token: null,
  CONFIG: {// TODO: read dynamically from config file
    debug: true, // set to false to turn off debug logging
    OVIRT_BASE_URL: 'https://engine.local/ovirt-engine',
  },
  actions: { // this list is for reference only, it's expected to be replaced by init()
    delayRefresh: function () {},
    deleteUnlistedVMs: function (vmNames) {},
    updateOrAddVm: function (vm) {},
  },

  _renderDisclaimer: function (text) { // TODO: if only automatic redirect works ... But CSP
    text = text ? text : _('The oVirt External Provider is installed but default Libvirt is used instead since oVirt' +
      ' login token is missing.<br/>If you want otherwise, please');
    var loc = window.location.href;
    var cockpitHost = loc.substring(0, loc.indexOf('/cockpit/'));
    var url = 'https://[ENGINE_HOST]/ovirt-engine/web-ui/authorizedRedirect.jsp?redirectUrl=' + cockpitHost + '/machines__hash__token=TOKEN';
    var div = document.createElement('div');
    // TODO: if it can't be resolved, then translation will be required
    div.innerHTML = '<p><span class="pficon-warning-triangle-o" />' +
      '&nbsp;' + text +
      '<ul><li>either land to cockpit from oVirt User Portal</li>' +
      '<li>or specify ENGINE_HOST in following link: ' + url + '</li></ul>' +
      '</p>';
    document.body.insertBefore(div, document.body.firstChild);
    window.setTimeout(function () {document.body.removeChild(div);}, 10000);
  },
  _renderUnauthorized: function () { // TODO: if only automatic redirect works ... But CSP
    OVIRT_PROVIDER._renderDisclaimer(_('Authorization expired. Log in again, please'));
  },
  _login: function (baseUrl) {
    var location = window.location;
    var tokenStart = location.hash.indexOf("token=");
    var token = window.sessionStorage.getItem('OVIRT_PROVIDER_TOKEN'); // as default

    if (tokenStart >= 0) { // TOKEN received as a part of URL has precedence
      token = location.hash.substr(tokenStart + "token=".length);
      logDebug("_login(): token found in params: " + token);
      OVIRT_PROVIDER.token = token;
      window.sessionStorage.setItem('OVIRT_PROVIDER_TOKEN', token);
      return true;
    } else if (token) { // search sessionStorrage
      logDebug("_login(): token found in sessionStorrage: " + token);
      OVIRT_PROVIDER.token = token;
      return true;
    } else { // TODO: redirect to SSO is recently not working because of CSP
      // redirect to oVirt's SSO
      var url = baseUrl + '/web-ui/authorizedRedirect.jsp?redirectUrl=' + location + '#token=TOKEN';
      logDebug("_login(): missing oVirt SSO token, redirecting to SSO: " + url);

      //window.cockpit.location.replace(url);
      /*            var a = document.createElement('a');
       a.setAttribute('href', 'http://www.google.com');
       a.innerText = 'My Link';
       document.body.appendChild(a);
       */

//            window.location = url;
      logError('SSO token is not provided!');
      OVIRT_PROVIDER._renderDisclaimer();
    }
    return false;
  },

  _ovirtApiGet: function (resource) {
    return $.ajax({
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/xml',
        'Authorization': 'Bearer ' + OVIRT_PROVIDER.token
      },
      url: OVIRT_PROVIDER.CONFIG.OVIRT_BASE_URL + '/api/' + resource
    }).fail(function (data) {
      logError('HTTP GET failed: ' + JSON.stringify(data));
      if (data.status === 401) { // Unauthorized
        OVIRT_PROVIDER._renderUnauthorized(); // TODO: or better redirect to SSO
      }
    });
  },

  _ovirtApiPost: function (resource, input) {
    return $.ajax({
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/xml',
        'Authorization': 'Bearer ' + OVIRT_PROVIDER.token
      },
      url: OVIRT_PROVIDER.CONFIG.OVIRT_BASE_URL + '/api/' + resource,
      data: input
    }).fail(function (data) {
      logError('HTTP POST failed: ' + JSON.stringify(data));
      if (data.status === 401) { // Unauthorized
        OVIRT_PROVIDER._renderUnauthorized(); // TODO: or better redirect to SSO
      }
    });
  },

  _adaptVm: function (ovirtVm) {
    var vcpus = function (ovirtCpu) {
      var t = ovirtCpu.topology;
      return t.sockets * t.cores * t.threads;
    };
    var currentMemory = function (ovirtMem) {
      return ovirtMem / 1024; // to KiB
    };
    var state = function (ovirtStatus) {
      return ovirtStatus;
    };

    return {
      id: ovirtVm.id,
      name: ovirtVm.name,
      state: state(ovirtVm.status),
      osType: ovirtVm.os.type,
      fqdn: ovirtVm.fqdn,
      uptime: -1, // TODO
      currentMemory: currentMemory(ovirtVm.memory),
      rssMemory: undefined, // TODO
      vcpus: vcpus(ovirtVm.cpu),
      autostart: undefined,
      actualTimeInMs: undefined, // TODO
      cpuTime: undefined // TODO
    };
  },
  /**
   * Initialize the Provider
   */
  init: function (actionCreators) {
    logDebug('init() called');
    OVIRT_PROVIDER.actions = actionCreators;
    return OVIRT_PROVIDER._login(OVIRT_PROVIDER.CONFIG.OVIRT_BASE_URL);
  },
  /*
   UNASSIGNED,
   DOWN,
   UP,
   POWERING_UP,
   PAUSED,
   MIGRATING,
   UNKNOWN,
   NOT_RESPONDING,
   WAIT_FOR_LAUNCH,
   REBOOT_IN_PROGRESS,
   SAVING_STATE,
   RESTORING_STATE,
   SUSPENDED,
   IMAGE_LOCKED,
   POWERING_DOWN */
  canReset: function (state) {
    return state && (state === 'up' || state === 'migrating');
  },
  canShutdown: function (state) {
    return OVIRT_PROVIDER.canReset(state) || (state === 'reboot_in_progress' || state === 'paused' || state === 'powering_up');
  },
  isRunning: function (state) {
    return OVIRT_PROVIDER.canReset(state);
  },
  canRun: function (state) {
    return state && (state === 'down' || state === 'paused' || state === 'suspended');
  },
  vmStateMap: { // TODO: localization needed
    unassigned: undefined,
    down: {className: 'fa fa-arrow-circle-o-down icon-1x-vms', title: 'The VM is down.'},
    up: {className: 'pficon pficon-ok icon-1x-vms', title: _("The VM is running.")},
    powering_up: {className: 'glyphicon glyphicon-wrench icon-1x-vms', title: _('The VM is going up.')},
    paused: {className: 'pficon pficon-pause icon-1x-vms', title: _('The VM is paused.')},
    migrating: {className: 'pficon pficon-route icon-1x-vms', title: _('The VM is migrating.')},
    unknown: undefined,
    not_responding: {className: 'pficon pficon-error-circle-o icon-1x-vms', title: _("The VM is not responding.")},
    wait_for_launch: {className: 'fa fa-clock-o icon-1x-vms', title: _('The VM is scheduled for launch.')},
    reboot_in_progress: undefined, // TODO
    saving_state: undefined,
    restoring_state: undefined,
    suspended: {className: 'pficon pficon-pause icon-1x-vms', title: _('The VM is suspended.')},
    image_locked: {className: 'fa fa-lock icon-1x-vms', title: _("The VM's image is locked.")},
    powering_down: {className: 'glyphicon glyphicon-wrench icon-1x-vms', title: _('The VM is going down.')},
  },

  /**
   * Get single VM
   * @param payload { lookupId: name }
   * @constructor
   */
  GET_VM: function (payload) {
    logDebug('GET_VM() called');
    logError('OVIRT_PROVIDER.GET_VM() is not implemented'); // should not be needed
    return function (dispatch) {
    };
  },

  /**
   * Initiate read of all VMs
   */
  GET_ALL_VMS: function () {
    logDebug('GET_ALL_VMS() called');
    return function (dispatch) {
      OVIRT_PROVIDER._ovirtApiGet('vms')
        .done(function (data) { // data is demarshalled JSON
          logDebug('GET_ALL_VMS successful');

          var vmNames = [];
          data.vm.forEach(function (ovirtVm) {
            var vm = OVIRT_PROVIDER._adaptVm(ovirtVm);
            vmNames.push(vm.name);
            dispatch(OVIRT_PROVIDER.actions.updateOrAddVm(vm));
          });

          // remove undefined domains
          dispatch(OVIRT_PROVIDER.actions.deleteUnlistedVMs(vmNames));

          // keep polling AFTER all VM details have been read (avoid overlap)
          dispatch(OVIRT_PROVIDER.actions.delayRefresh());
        });
    };
  },

  /**
   * Call `shut down` on the VM
   * @param payload { name, id }
   * @constructor
   */
  SHUTDOWN_VM: function (payload) {
    var name = payload.name;
    var id = payload.id;
    logDebug('OVIRT_PROVIDER.SHUTDOWN_VM(name="' + name + '", id="' + id + '")');
    return function (dispatch) {
      return OVIRT_PROVIDER._ovirtApiPost('vms/' + id + '/shutdown', '<action />');
    };
  },

  /**
   * Force shut down on the VM.
   *
   * @param payload { name, id }
   * @constructor
   */
  FORCEOFF_VM: function (payload) {
    var name = payload.name;
    var id = payload.id;
    logDebug('OVIRT_PROVIDER.FORCEOFF_VM(name="' + name + '", id="' + id + '")');
    return function (dispatch) {
      return OVIRT_PROVIDER._ovirtApiPost('vms/' + id + '/stop', '<action />');
    };
  },

  REBOOT_VM: function (payload) {
    var name = payload.name;
    var id = payload.id;
    logDebug('OVIRT_PROVIDER.REBOOT_VM(name="' + name + '", id="' + id + '")');

    return function (dispatch) {
      return OVIRT_PROVIDER._ovirtApiPost('vms/' + id + '/reboot', '<action />');
    };
  },

  FORCEREBOOT_VM: function (payload) {
    return OVIRT_PROVIDER.REBOOT_VM(payload); // TODO: implement 'force'
  },

  START_VM: function (payload) {
    var name = payload.name;
    var id = payload.id;
    logDebug('OVIRT_PROVIDER.START_VM(name="' + name + '", id="' + id + '")');

    return function (dispatch) {
      return OVIRT_PROVIDER._ovirtApiPost('vms/' + id + '/start', '<action />');
    };
  }
};

function init () {
  console.log('Registering oVirt provider');
  window.EXTERNAL_PROVIDER = OVIRT_PROVIDER;
}

init();
