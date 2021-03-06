var RancherClient = require('rancher-cli-async/dist/rancher');
var yaml = require('js-yaml');
var rimraf = require('rimraf');
var request = require('request');
var each = require('async-each');
var encryptEnv = require('encrypt-env');
var envfile = require('envfile');
var mkdirp = require('mkdirp');
var fs = require('fs');
var path = require('path');

var utils = require('./utils');

module.exports = function (rancherOptions, extras) {
  var that = {};

  var rancher = new RancherClient(rancherOptions);

  var AES_KEY = extras.AES_KEY;
  var DOCKER_COMPOSE_FILE = extras.DOCKER_COMPOSE_FILE;
  var RANCHER_PROJECT_ID = rancherOptions.projectId;
  var RANCHER_LOADBALANCER_ID = extras.RANCHER_LOADBALANCER_ID;

  var github = require('./github')(extras.GITHUB_API_TOKEN);

  var docker = require('./docker')({
    username: extras.DOCKER_HUB_USERNAME,
    password: extras.DOCKER_HUB_PASSWORD
  });

  var getStackName = function (repoCreds, commitHash, branch) {
    if (branch) return repoCreds.repo + '-' + branch;
    return repoCreds.repo + '-' + commitHash;
  };

  var rancherGetRequest = function (stub, cb) {
    request({
      url: path.join(rancherOptions.address, '/v1/projects/', RANCHER_PROJECT_ID, stub),
      auth: {
        user: rancherOptions.auth.accessKey,
        pass: rancherOptions.auth.secretKey
      },
      headers: {
        'content-type': 'application/json'
      },
      json: true
    }, function (err, response, body) {
      if (err) return cb(err);
      if (!err && response.statusCode === 200) {
        return cb(null, body);
      }
      cb(body);
    });
  };

  var rancherPostRequest = function (stub, payload, cb) {
    request({
      url: path.join(rancherOptions.address, '/v1/projects/', RANCHER_PROJECT_ID, stub),
      auth: {
        user: rancherOptions.auth.accessKey,
        pass: rancherOptions.auth.secretKey
      },
      method: 'POST',
      json: true,
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, function (err, response, body) {
      if (err) return cb(err);

      if (!err && response.statusCode === 200) {
        return cb(null, body);
      }
      cb(body);
    });
  };

  var downloadComposeFile = function (opts, cb) {
    var onwritecomposefilewithenv = function (err) {
      if (err) return cb(err);
      return cb();
    };

    var ongetencryptedenv = function (err, result) {
      if (err) return cb(err);

      var doc = yaml.safeLoad(fs.readFileSync(opts.composeFilePath, 'utf8'));

      const envs = Object.keys(result).map(function (item) {
        const decryptedEnv = encryptEnv('KEY', {'KEY': AES_KEY}).decryptEnv(false, result[item].encryptedEnv);
        result[item].decryptedEnv = envfile.parseSync(decryptedEnv);
        return result[item];
      }).reduce(function (prevItem, item) {
        prevItem[item.path] = item;
        return prevItem;
      }, {});

      Object.keys(doc).forEach(function (service) {
        if (doc[service].hasOwnProperty('labels') && doc[service].labels['sealand.rewrite']) {
          if (doc[service].env_file) {
            doc[service].environment = envs[doc[service].env_file + '.enc'].decryptedEnv;
            delete doc[service]['env_file'];
          }
          doc[service].image += ':' + opts.commitHash;
        }
      });

      fs.writeFile(opts.composeFilePath, yaml.safeDump(doc, {noRefs: true}), onwritecomposefilewithenv);
    };

    var oncheckdocker = function (err) {
      if (err) return cb(err);

      var doc = yaml.safeLoad(fs.readFileSync(opts.composeFilePath, 'utf8'));
      var envFiles = [...new Set(Object.keys(doc)
        .filter(item => doc[item].env_file !== undefined)
        .map(item => doc[item].env_file + '.enc'))];

      const getFile = github.getFileMany(opts.repoCreds, opts.commitHash);
      each(envFiles, getFile, ongetencryptedenv);
    };

    var onwritecomposefile = function (err) {
      if (err) return cb(err);

      var doc = yaml.safeLoad(fs.readFileSync(opts.composeFilePath, 'utf8'));
      var services = Object.keys(doc).filter(function (item) {
        if (doc[item].hasOwnProperty('labels')) {
          return doc[item].labels['sealand.rewrite'];
        }
        return false;
      }).map(item => doc[item].image);
      each(services, docker.checkHubForImage(opts.commitHash), oncheckdocker);
    };

    var ongetcomposefile = function (err, composeFile) {
      if (err) return cb(err);

      mkdirp(utils.getTmpDir(opts.repoCreds), function (err) {
        if (err) return cb(err);

        fs.writeFile(opts.composeFilePath, composeFile, onwritecomposefile);
      });
    };

    github.getFile(opts.repoCreds, opts.commitHash, opts.composeFile, ongetcomposefile);
  };

  that.deployCommit = function (options, cb) {
    var composeFile = options.composeFile || DOCKER_COMPOSE_FILE;
    var composeFilePath = utils.getComposeFilePath(options.repoCreds, composeFile);
    downloadComposeFile(Object.assign(options, { composeFilePath, composeFile }), function (err) {
      if (err) return cb(err);

      rancher.exec('-f ' + composeFilePath + ' -p ' + getStackName(options.repoCreds, options.commitHash, options.branch) + ' up -d --upgrade -c', function (err) {
        if (err) return cb(err);
        cb();
      });
    });
  };

  that.killCommit = function (options, cb) {
    var composeFilePath = utils.getComposeFilePath(options.repoCreds, DOCKER_COMPOSE_FILE);

    var ondownloadcomposefile = function (err) {
      if (err) return cb(err);

      rancher.exec('-f ' + composeFilePath + ' -p ' + getStackName(options.repoCreds, options.commitHash) + ' rm --force', function (err) {
        if (err) return cb(err);

        rimraf(utils.getTmpDir(options.repoCreds), function (err) {
          if (err) return cb(err);
          cb();
          that.deleteStack(options, function (result) {
            return console.log(JSON.stringify(result));
          });
        });
      });
    };

    downloadComposeFile(Object.assign(options, { composeFilePath }), ondownloadcomposefile);
  };

  that.deleteStack = function (options, cb) {
    var stackName = getStackName(options.repoCreds, options.commitHash);

    var ondeletestack = function (err, result) {
      if (err) return cb(err);
      cb(null, result);
    };

    var onsearchstacks = function (err, stacks) {
      if (err) return cb(err);
      if (stacks.data && stacks.data.length < 1) return cb({errror: 'No stacks found matching: ' + stackName});

      var stack = stacks.data.pop();

      rancherPostRequest('/environments/' + stack.id + '/?action=remove', {}, ondeletestack);
    };

    rancherGetRequest('/environment?name=' + stackName, onsearchstacks);
  };

  that.getLoadbalancerStatus = function (cb) {
    rancherGetRequest('/serviceconsumemaps?serviceId=' + RANCHER_LOADBALANCER_ID, function (err, serviceConsumeMaps) {
      if (err) return cb(err);

      var mappings = serviceConsumeMaps.data.map(function (s) {
        return s.ports.pop().split('=')[0].replace(':80', '');
      });

      cb(null, mappings);
    });
  };

  return that;
};
