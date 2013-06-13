module.exports = function (sails) {


	/**
	 * Module dependencies.
	 */

	var _		= require( 'lodash' ),
		async	= require( 'async' ),
		util	= require( '../../util' ),
		Modules	= require( '../../moduleloader' );



	/**
	 * Expose `Controller` hook definition
	 */

	return {


		/**
		* Middleware that available as part of the public API
		*/

		middleware: {},



		/**
		 * Routes to bind before or after routing
		 */

		routes: {
			
			before: {},

			after: {}
		},


		/**
		 * Wipe everything and (re)load middleware from controllers, policies, config, and views.
		 *
		 * @api private
		 */

		loadMiddleware: function (cb) {
			var self = this;

			sails.log.verbose('Building middleware registry...');

			async.auto({

				policies: [function (cb) {
					sails.log.verbose('Loading app policies...');

					// Load policy modules
					sails.policies = Modules.optional({
						dirname		: sails.config.paths.policies,
						filter		: /(.+)\.(js|coffee)$/,
						replaceExpr	: null
					});

					// Register policies
					_.extend(self.middleware, sails.policies);

					cb();
				}],

				views: ['policies', function (cb) {

					// Load views, just so we know whether they exist or not
					sails.views = Modules.optional({
						dirname		: sails.config.paths.views,
						filter		: /(.+)\..+$/,
						replaceExpr	: null,
						dontLoad	: true
					});

					// If there are any matching views which don't have an action
					// create middleware to serve them
					_.each(sails.views, function (view, controllerId) {

						// Create middleware for a top-level view
						if (view === true) {
							self.middleware[controllerId] = ViewMiddleware;
						}

						// Create middleware for each subview
						else {
							self.middleware[controllerId] = {};
							for (var actionId in sails.views[controllerId]) {
								self.middleware[controllerId][actionId] = ViewMiddleware;
							}
						}

					});

					cb();
				}],
			
				controllers: ['policies', 'views', function (cb) {

					sails.log.verbose('Loading app controllers...');

					// Load app controllers
					sails.controllers = Modules.optional({
						dirname		: sails.config.paths.controllers,
						filter		: /(.+)Controller\.(js|coffee)$/,
						replaceExpr	: /Controller/
					});

					// Get federated controllers where actions are specified each in their own file
					var federatedControllers = Modules.optional({
						dirname			: sails.config.paths.controllers,
						pathFilter		: /(.+)\/(.+)\.(js|coffee)$/
					});
					sails.controllers = _.extend(sails.controllers,federatedControllers);


					// Register controllers
					_.each(sails.controllers, function (controller, controllerId) {

						// Override whatever was here before
						if (!_.isObject(self.middleware[controllerId])) {
							self.middleware[controllerId] = {};
						}
						
						// Mix in middleware from controllers
						_.each(controller, function (action, actionId) {

							// If the action is set to `false`, explicitly disable it
							if (action === false) {
								delete self.middleware[controllerId][actionId];
							}

							// Otherwise mix it in
							else if (_.isFunction(action)) {
								self.middleware[controllerId][actionId] = action;
							}

						});



						////////////////////////////////////////////////////////
						// (LEGACY SUPPORT)
						// Prepend policies to chain, as per policy configuration

						var controllerPolicy = sails.config.policies[controllerId];
						
						// If a policy doesn't exist for this controller, use '*'
						if ( _.isUndefined(controllerPolicy) ) {
							controllerPolicy = sails.config.policies['*'];
						}
						
						// Normalize policy to an array
						controllerPolicy = normalizePolicy( controllerPolicy );

						// If this is a top-level policy, apply it immediately
						if ( _.isArray(controllerPolicy) ) {

							// If this controller is a container object, apply the policy to all the actions
							if ( _.isObject(self.middleware[controllerId]) ) {
								_.each(self.middleware[controllerId], function (action, actionId) {
									  self.middleware[controllerId][actionId] = controllerPolicy.concat([self.middleware[controllerId][actionId]]);
								});
							}

							// Otherwise apply the policy directly to the controller
							else if ( _.isFunction(self.middleware[controllerId]) ) {
								self.middleware[controllerId] = controllerPolicy.concat([self.middleware[controllerId]]);
							}
						}
						
						// If this is NOT a top-level policy, and merely a container of other policies,
						// iterate through each of this controller's actions and apply policies in a way that makes sense
						else {
							_.each(self.middleware[controllerId], function (action, actionId) {

								var actionPolicy =	sails.config.policies[controllerId][actionId];
								
								// If a policy doesn't exist for this controller, use the controller-local '*'
								if ( _.isUndefined(actionPolicy) ) {
									actionPolicy = sails.config.policies[controllerId]['*'];
								}

								// if THAT doesn't exist, use the global '*' policy
								if ( _.isUndefined(actionPolicy) ) {
									actionPolicy = sails.config.policies['*'];
								}

								// Normalize action policy to an array
								actionPolicy = normalizePolicy( actionPolicy );

								self.middleware[controllerId][actionId] = actionPolicy.concat([self.middleware[controllerId][actionId]]);
							});
						}

						////////////////////////////////////////////////////////

					});

					cb();
				}]

			}, cb);
		},




		/**
		 * Generate resourceful routes based on modules
		 *
		 * @api private
		 */

		autoRoute: function (cb) {

			var self;

			// Start iterating through controllers
			_.each(sails.controllers, function (controller, controllerId) {

				// Instead of using the actual controller definition,
				// look up the version in the middleware registry, 
				// since it might have policies attached
				controller = this.middleware[controllerId];

				// If a controller is the middleware itself, 
				// create a route for it directly, then bail out
				if (_.isFunction(controller) || _.isArray(controller) ) {
					this.routes.after['/' + controllerId] = controller;
					return;
				}
				
				// Build routes for each action
				_.each(controller, function (target, actionId) {
					
					// If this isn't a valid target, bail out
					if (! (_.isFunction(target) || _.isArray(target)) ) {
						sails.log.warn('Action ('+actionId+') in "'+controllerId+'" could not be dynamically routed because it isn\'t an array or a function.');
						return;
					}

					// Check for verb in actionId
					var detectedVerb = util.detectVerb(actionId);
					actionId = detectedVerb.original;
					var verb = detectedVerb.verb;

					// If a verb is set, the prefix looks like `get /`
					// otherwise, it's just a trailing slash
					var prefix = verb ? verb + ' /' : '/';

					// Bind dynamic routes
					if (actionId === 'index') {
						this.routes.after[prefix + controllerId] = target;
					}
					this.routes.after[prefix + controllerId + '/' + actionId] = target;

				}, this);
				
			}, this);


			// If the views hook is enabled, or when it is, also auto-bind views
			sails.after('hook:load:views', function () {

				// If there are any matching views which don't have an action
				// create middleware to serve them
				_.each(sails.views, function (view, controllerId) {

					// Create middleware for a top-level view
					if (view === true) {
						self.routes.after['/' + controllerId] = self.middleware[controllerId];
						return;
					}

					// Create middleware for each subview
					else {
						// Build routes for each action
						for (var actionId in sails.views[controllerId]) {

							if (actionId === 'index') {
								self.routes.after['get /' + controllerId] = self.middleware[controllerId][actionId];
							}
							self.routes.after['get /' + controllerId + '/' + actionId] = self.middleware[controllerId][actionId];
						}
					}

				}, self);
			});

			cb(); // Done.
		},


		/**
		 * Initialize is fired first thing when the hook is loaded
		 *
		 * @api public
		 */

		 initialize: function (cb) {
			async.series([
				this.loadMiddleware,
				this.autoRoute
			], cb);
		}
	};




	/**
	 * Convert policy into array notation
	 *
	 * @param {Object} options
	 * @api private
	 */

	function normalizePolicy ( policy ) {

		// Recursively normalize lists of policies
		if (_.isArray(policy)) {
			for (var i in policy) {
				normalizePolicy(policy[i]);
			}
			return policy;
		}
		
		else if (_.isString(policy) || _.isFunction(policy)) {
			return [ policy ];
		}
		
		else if (!policy) {
			return [ function (req,res,next) { res.send(403); } ];
		}

		else if (policy === true) {
			return [ function (req,res,next) { next(); } ];
		}
		
		sails.log.error('Cannot map invalid policy: ', policy);
		return [function (req,res) {
			throw new Error('Invalid policy: ' + policy);
		}];
	}



	/**
	 * Simple view middleware used to serve views w/o controllers
	 */

	function ViewMiddleware (req,res) {
		res.view();
	}

};
