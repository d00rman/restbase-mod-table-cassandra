"use strict";
/**
 * Simple Cassandra-based revisioned storage implementation
 *
 * Implements (currently a subset of) the functionality documented in
 * https://www.mediawiki.org/wiki/User:GWicke/Notes/Storage#Strawman_backend_API
 *
 * Interface is intended to be general, so that other backends can be dropped
 * in. We don't want inheritance though, just implementing the interface is
 * enough.
 */

var util = require('util'),
	events = require('events'),
	cass = require('node-cassandra-cql'),
	consistencies = cass.types.consistencies,
	uuid = require('node-uuid');

function CassandraRevisionStore (client) {
	var self = this;

	// convert consistencies from string to the numeric constants
	this.consistencies = {
		read: 1,
		write: 1
	};

	self.client = client;
}

util.inherits(CassandraRevisionStore, events.EventEmitter);

var CRSP = CassandraRevisionStore.prototype;

function tidFromDate(date) {
	// Create a new, deterministic timestamp
	return uuid.v1({
		node: [0x01, 0x23, 0x45, 0x67, 0x89, 0xab],
		clockseq: 0x1234,
		msecs: date.getTime(),
		nsecs: 0
	});
}

/**
 * Add a new revision with several properties
 */
CRSP.addRevision = function (revision) {
	var tid;
	if(revision.timestamp) {
		// Create a new, deterministic timestamp
		// XXX: pass in a date directly
		tid = tidFromDate(new Date(revision.timestamp));
	} else {
		tid = uuid.v1();
	}
	// Build up the CQL
	// Simple revison table insertion only for now
	var cql = 'BEGIN BATCH ',
		args = [],
		props = Object.keys(revision.props);
	// Insert the _rev metadata
	cql += 'insert into revisions (name, prop, tid, revtid, value) ' +
			'values(?, ?, ?, ?, ?);\n';
	args = args.concat([
			revision.page.title,
			'_rev',
			tid,
			tid,
			new Buffer(JSON.stringify({rev:revision.id}))]);

	// Insert the revid -> timeuuid index
	cql += 'insert into idx_revisions_by_revid (revid, name, tid) ' +
			'values(?, ?, ?);\n';
	args = args.concat([
			revision.id,
			revision.page.title,
			tid]);

	// Now insert each revision property
	props.forEach(function(prop) {
		cql += 'insert into revisions (name, prop, tid, revtid, value) ' +
			'values(?, ?, ?, ?, ?);\n';
		args = args.concat([
			revision.page.title,
			prop,
			tid,
			tid,
			revision.props[prop].value]);
	});

	// And finish it off
	cql += 'APPLY BATCH;';

	return this.client.executeAsPrepared_p(cql, args, this.consistencies.write)
    .then(function() {
        return {tid: tid};
    });
};

/**
 * Get the latest version of a given property of a page
 *
 * Takes advantage of the latest-first clustering order.
 */
CRSP.getRevision = function (name, rev, prop) {
    var resolve, reject;
    var pr = new Promise(function(res, rej) {
        resolve = res;
        reject = rej;
    });
	var queryCB = function (err, results) {
			if (err) {
				reject(err);
			} else if (!results || !results.rows || results.rows.length === 0) {
				resolve([]);
			} else {
				resolve(results.rows);
			}
		},
		consistencies = this.consistencies,
		client = this.client,
		cql = '',
		args = [], tid;

	if (rev === 'latest') {
		// Build the CQL
		cql = 'select value from revisions where name = ? and prop = ? limit 1;';
		args = [name, prop];
		client.executeAsPrepared(cql, args, consistencies.read, queryCB);
	} else if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(rev)) {
		// By UUID
		cql = 'select value from revisions where name = ? and prop = ? and tid = ? limit 1;';
		args = [name, prop, rev];
		return client.executeAsPrepared(cql, args, consistencies.read, queryCB);
	} else {
		switch(rev.constructor) {
			case Number:
				// By MediaWiki oldid

				// First look up the timeuuid from the revid
				cql = 'select tid from idx_revisions_by_revid where revid = ? limit 1;';
				args = [rev];
				client.executeAsPrepared(cql, args, consistencies.read, function (err, results) {
							if (err) {
								reject(err);
							}
							if (!results.rows.length) {
								resolve('Revision not found'); // XXX: proper error
							} else {
								// Now retrieve the revision using the tid
								tid = results.rows[0][0];
								cql = 'select value from revisions where ' +
									'name = ? and prop = ? and tid = ? limit 1;';
								args = [name, prop, tid];
								client.executeAsPrepared(cql, args, consistencies.read, queryCB);
							}
						});
				break;
			case Date:
				// By date
				tid = tidFromDate(rev);
				cql = 'select value from revisions where name = ? and prop = ? and tid <= ? limit 1;';
				args = [name, prop, tid];
				client.executeAsPrepared(cql, args, consistencies.read, queryCB);
				break;
		}
	}
    return pr;
};

module.exports = CassandraRevisionStore;