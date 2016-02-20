var MACRO = require('./model/macro.js');
var mongoose = require('mongoose');
var https = require('https');
var fs = require('fs');
var url = require('url');
var md5 = require('md5');

var Users = mongoose.model('Users');
var Notifications = mongoose.model('Notifications');
var Challenges = mongoose.model('Challenges');

var nextUserId = 0;
global.usersById = {};
var usersByGhId = {};


exports.send_mail = function (destination, type, body, subject) {
  var nodemailer = require("nodemailer");

  // create reusable transport method (opens pool of SMTP connections)
  var smtpTransport = nodemailer.createTransport("SMTP",{
    service: "Gmail",
    auth: {
      user: global.config.mail_user,
      pass: global.config.mail_pass
    }
  });

  fs.readFile(__dirname + '/public/emails/' + type + '.html', 'utf8', function (err, html) {
      var mailOpt = {};

      if (type == 'welcome') {
        mailOpt['from']    = 'ROSEdu Challenge <challenge@lists.rosedu.org>';
        mailOpt['to']      = destination,
        mailOpt['subject'] = 'Welcome to Challenge by ROSEdu',
        mailOpt['text']    = '',
        mailOpt['html']    = html;
      } else if (type == 'feedback') {
        mailOpt['from']    = 'ROSEdu Challenge <challenge@lists.rosedu.org>';
        mailOpt['to']      = 'challenge@lists.rosedu.org',
        mailOpt['subject'] = 'Feedback: ' + body.email,
        mailOpt['text']    = body.msg
      } else if (type == 'challenge') {
        mailOpt['from']    = 'ROSEdu Challenge <challenge@lists.rosedu.org>';
        mailOpt['to']      = destination,
        mailOpt['subject'] = subject,
        mailOpt['text']    = body
      }

      // send mail with defined transport object
      smtpTransport.sendMail(mailOpt, function(err, response){
        if (err) console.log(err);
        else console.log("* Email sent to " + destination);

        smtpTransport.close();
      });
  });
}


function addUser (source, sourceUser) {
  var user;
  if (arguments.length === 1) { // password-based
    user = sourceUser = source;
    user.id = ++nextUserId;
    return usersById[nextUserId] = user;
  } else { // non-password-based
    user = usersById[++nextUserId] = {id: nextUserId};
    user[source] = sourceUser;
  }
  return user;
}


exports.login = function(sess, accessToken, accessTokenExtra, ghUser) {
  sess.oauth = accessToken;
  if (typeof usersByGhId[ghUser.id] === 'undefined') {

    usersByGhId[ghUser.id] = addUser('github', ghUser);

    Users
    .findOne({ 'user_id': usersByGhId[ghUser.id].github.id },
               'user_name', function (err, user) {
      if (err) return handleError(err);
      if (user != null) {
        // update last_seen
        var conditions = {'user_name': user.user_name};
        var update = {$set: {
          'last_seen':     Date.now(),
          'user_fullname': usersByGhId[ghUser.id].github.name,
          'user_email':    usersByGhId[ghUser.id].github.email,
          'followers_no':  usersByGhId[ghUser.id].github.followers,
          'following_no':  usersByGhId[ghUser.id].github.following,
          'location':      usersByGhId[ghUser.id].github.location,
        }};
        Users.update(conditions, update, function (err, num) {
          console.log("* User " + user.user_name + " logged in.");
        });

      } else {
        // Send welcome notification
        new Notifications({
          'src':    null,
          'dest':   usersByGhId[ghUser.id].github.login,
          'type':   "welcome",
          'link':   "/faq"
        }).save(function(err, todo, count) {
          if (err) console.log("[ERR] Notification not sent.");
        });

        // Import data from github
        return new Users ({
          'user_id':       usersByGhId[ghUser.id].github.id,
          'user_name':     usersByGhId[ghUser.id].github.login,
          'user_fullname': usersByGhId[ghUser.id].github.name,
          'user_email':    usersByGhId[ghUser.id].github.email,
          'avatar_url':    usersByGhId[ghUser.id].github.avatar_url,
          'location':      usersByGhId[ghUser.id].github.location,
          'join_github':   usersByGhId[ghUser.id].github.created_at,
          'followers_no':  usersByGhId[ghUser.id].github.followers,
          'following_no':  usersByGhId[ghUser.id].github.following
        }).save (function (err, user, count) {
          console.log("* User " + user.user_name + " added.");
          // send welcome email
          module.exports.send_mail(user.user_email, 'welcome');
        });
      }
    });
    return usersByGhId[ghUser.id];

  } else {
    return usersByGhId[ghUser.id];
  }
}


exports.get_time_from = function (then) {
  var now = Date.now();

  // interval between time now and db date
  var msec = now - new Date(then).getTime();

  var hh = Math.floor(msec / 1000 / 60 / 60);
  if (hh > 24) { // older that 24 hours
    // return actual date
    return "on " + then.toString().substring(4, 15);

  } else if (hh > 1) { // older than 1 hour
    return hh + " hours ago";

  } else {
    msec -= hh * 1000 * 60 * 60;
    var mm = Math.floor(msec / 1000 / 60);

    if (mm > 1) { // older than 1 mnute
      return mm + " minutes ago";

    } else {
      return "one minute ago";
    }
  }
}


function create_patch_request(ch, pull) {
    var patch_url = pull.url;
    var patch_url_host = url.parse(patch_url, true).host;
    var patch_url_path = url.parse(patch_url, true).pathname;

    var patch_options = {
      host: patch_url_host,
      path: patch_url_path,
      method: "GET",
      headers: { "User-Agent": "github-connect" }
    };

    var patch_request = https.request(patch_options, function(response) {
      var pull_body = '';

      response.on("data", function(chunk) {
        pull_body+=chunk.toString("utf8");
      });

      response.on("end", function() {
        var pull_info = JSON.parse(pull_body);

        // Check if merge date exists
        var merge_date;

        if (!pull.merged_at) merge_date = null;
        else merge_date = new Date(pull.merged_at);

        // Generate unique PR id
        var oid = md5(pull.html_url).substring(0,12)

        var update = {$set: {
          'pulls.$.title':          pull.title,
          'pulls.$.created':        new Date(pull.created_at),
          'pulls.$.merged':         merge_date,
          'pulls.$.lines_inserted': pull_info.additions,
          'pulls.$.lines_removed':  pull_info.deletions,
          'pulls.$.files_changed':  pull_info.changed_files
        }}

        Challenges.update({'pulls.url': pull.html_url}, update, function (err, count) {
          // No updates were made, object did not exist, let's push it
          if (count == 0) {
            var newpr = {
              '_id':            new mongoose.Types.ObjectId(oid),
              'repo':           pull.base.repo.full_name,
              'auth':           pull.user.login,
              'hide':           false,
              'url':            pull.html_url,
              'title':          pull.title,
              'created':        new Date(pull.created_at),
              'merged':         merge_date,
              'score':          0,
              'rating':         0,
              'lines_inserted': pull_info.additions,
              'lines_removed':  pull_info.deletions,
              'files_changed':  pull_info.changed_files
            }

            // Update score if formulae is valid
            if (exports.eval_formulae(ch.formulae))
              newpr['score'] = exports.eval_formulae(ch.formulae, newpr)

            Challenges.update({'link': ch.link}, {$push: {pulls: newpr}}).exec()
          }
        })
      });

    });
    patch_request.end();
}

/*
Replace individual constants in formulae with actual values
and supply a result.

If pull argument is missing, test arithmetic expression using a default value
and try to evaluate expression. Returns null if failed.

IL - Inserted lines
RL - Removed lines
FC - Files changed
R  - Rating
*/
exports.eval_formulae = function(formulae, pull) {

  // Default test value, if parameter is missing
  pull = pull || {
    'lines_inserted': 0,
    'lines_removed': 0,
    'files_changed': 0,
    'rating': 0
  }

  // Replace all occurances
  formulae = formulae.replace(/IL/g, pull.lines_inserted)
  formulae = formulae.replace(/RL/g, pull.lines_removed)
  formulae = formulae.replace(/FC/g, pull.files_changed)
  formulae = formulae.replace(/R/g,  pull.rating)

  try {
    score = eval(formulae)
  } catch(err) {
    score = null
  }

  return score
}

/*
Refresh all repos from all challeneges that are active ('live').
*/
exports.refresh_challenges = function() {

  Challenges.find({'status': 'live'}).exec(gotChallenges);

  function gotChallenges(err, all) {

    // For each challenge in pool
    for (var c in all) {

      var ch = all[c];

      // Update last refresh date
      var update = {$set: {'refresh': Date.now()}};
      Challenges.update({'link': ch.link}, update).exec();

      //New request for each repo of challenge
      for (var r=0; r<ch.repos.length; r++) {

        var options = {
          host: "api.github.com",
          path: "/repos/" + ch.repos[r] + "/pulls?state=all",
          method: "GET",
          headers: { "User-Agent": "github-connect" }
        };

        var request = https.request(options, function(response){
          var body = '';

          response.on("data", function(chunk){
            body+=chunk.toString("utf8");
          });

          response.on("end", function(){
            var pulls = JSON.parse(body);

            // Log errors
            if (pulls.message)
              console.log("[ERR] " + pulls.message + " - " + options.path
                + " (" + pulls.documentation_url + ")");

            for (var p in pulls) {

              // Accept only pulls created after challenge start date, before end
              // date and only from registered users
              if (new Date(pulls[p].created_at).getTime() > ch.start.getTime() &&
                  new Date(pulls[p].created_at).getTime() < ch.end.getTime() &&
                  ch.users.indexOf(pulls[p].user.login) > -1) {

                create_patch_request(ch, pulls[p]);
              }
            }
          });
        });
        request.end();

      }
    }
  }
}

/*
Adds dummy user with given id and username to db.
This is used during development when multiple users are needed for testing
purposes.
*/
exports.add_user = function(userid, username, callback) {
  var u = {'id': userid, 'login': username}

  // Add some content for user
  var repo = {
    'name':           username + '\'s cool repo',
    'description':    'A very nice description should be added here.',
    'html_url':       'http://www.github.com',
    'fork':           true,
    'forks_count':    3,
    'watchers_count': 5,
    'closed_pulls':   3,
  }
  var update = {
    'user_id':       u.id,
    'user_name':     u.login,
    'user_fullname': 'Development user',
    'user_email':    'dev@github-connect.com',
    'avatar_url':    'https://avatars.githubusercontent.com/u/0',
    'location':      'Somewhere',
    'repos':         [repo]
  }

  Users.update({'user_id': u.id}, update, {'upsert': true}).exec(callback)
}
