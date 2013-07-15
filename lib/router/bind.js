module.exports = function (sails) {


	/**
	 * Module dependencies.
	 */


	var _		= require( 'lodash' ),
		util	= require( '../util' );



	/**
	 * Expose `bind` method.
	 */

	return bind;



	/**
	 * Bind new route(s)
	 *
	 * @param {String|RegExp} path
	 * @param {String|Object|Array|Function} target
	 * @param {String} verb (optional)
	 * @api private
	 */

	function bind ( path, target, verb ) {

		// If trying to bind '*', that's probably not what was intended, so fix it up
		path = path === '*' ? '/*' : path;

		// If path has an HTTP verb, parse it out
		var detectedVerb = util.detectVerb(path);
		path = detectedVerb.original;

		// Preserve the explicit verb argument if it was specified
		if (!verb) {
			verb = detectedVerb.verb;
		}	

		// Handle target chain syntax
		if (_.isArray(target)) {
			return bindArray(path, target, verb);
		}

		if (_.isObject(target) && !_.isFunction(target) && !_.isArray(target)) {
			
			if (_.isUndefined(target.middleware)) {
				return bindController(path, target, verb);
			}

			return bindMiddleware(path, target, verb);
		}

		if (_.isString(target)) {
			return bindString(path, target, verb);
			
		}

		// Inline target function
		if (_.isFunction(target)) {

			// Route to middleware function
			return bindFunction(path, target, verb);
		}


		// If we make it here, the specified target property is invalid
		// No reason to crash the app in this case, so just ignore the bad route
		logInvalidRouteError(path, target, verb);

	}



	function bindArray ( path, target, verb ) {
		_.each(target, function (fn) {
			bind(path, fn, verb);
		});
	}



	/**
	 * controller/action syntax
	 * TODO: pull this logic into the controllers hook
	 */

	function bindController ( path, target, verb ) {

		// Look up appropriate controller/action (or view) and make sure it exists
		var controller = sails.middleware.controllers[target.controller] || sails.middleware.views[target.controller];

		// If a controller was specified but it doesn't match, warn the user
		if ( ! (controller && util.isDictionary(controller) && controller[target.action || 'index']) ) {

			sails.log.error(
				target.controller + '.' + (target.action || 'index'),
				':: Ignoring attempt to bind route (' + path + ') to unknown controller.action.'
			);
			return;
		}

		// If specified, lookup the `action` function, otherwise lookup index
		var subTarget = controller[target.action || 'index'];

		// Make sure the controller function (+/- policies, etc.) is usable
		if (_.isArray(subTarget)) {
			_.each(subTarget, function (fn) {
				_bind(path, controllerHandler(fn), verb);
			});
			return;
		}
		
		// Bind a controller function to the destination route
		_bind(path, controllerHandler(subTarget), verb);


		// Wrap up the controller middleware to supply access to
		// the original target when requests comes in
		function controllerHandler (originalFn) {

			if ( !_.isFunction(originalFn) ) {
				sails.log.error(target.controller + '.' + target.action + ' :: ' +
					'Ignoring invalid attempt to bind route to a non-function controller:', 
					originalFn, 'for path: ', path, verb ? ('and verb: ' + verb) : '');
				return;
			}
			
			// Bind intercepted middleware function to route
			return function wrapperFn (req, res, next) {
				
				// Set target metadata
				req.target = {
					controller: target.controller,
					action: target.action || 'index'
				};
				
				// Call actual controller
				originalFn(req, res, next);
			};
		}

		return;
	}


	
	/**
	 * simple middleware function syntax
	 */

	function bindFunction ( path, fn, verb ) {
		_bind ( path, fn, verb );
	}




	function bindString ( path, target, verb ) {

		// Handle dot notation
		var parsedTarget = target.match(/^([^.]+)\.?([^.]*)?$/);
		
		// If target matches a controller in the middleware registry
		// go ahead and assume that this is a dot notation route
		// TODO: pull this logic into the controllers hook
		if (parsedTarget[1] && sails.middleware.controllers[parsedTarget[1]]) {

			bind(path, {
				controller: parsedTarget[1],
				action: parsedTarget[2]
			}, verb);

			return;
		}

		// Otherwise if the target cannot be parsed as dot notation,
		// redirect requests to the specified string (which hopefully is a URL!)
		_bind (path, function (req, res) {
			sails.log.verbose('Redirecting request (`' + path + '`) to `' + target + '`...');
			res.redirect(target);
		}, verb);

		return;
	}


	/**
	 * Attach middleware function to route
	 *
	 * @api prvate
	 */

	function _bind ( path, fn, verb ) {

		sails.log.verbose('Binding route :: ', verb || '', path);

		// Ensure that fn is a function
		if ( !_.isFunction(fn) ) {
			sails.log.error(
				(verb ? verb + ' ' : ''),
				path,
				':: Ignoring invalid attempt to bind route to a non-function:',
				fn
			);
			return;
		}

		// Middleware event
		// Parameter augmentations must be made here, since they occur 
		// on a per-middleware, not per-route, basis
		var enhancedFn = function (req,res,next) {
			
			// This event can be tapped into to take control of logic
			// that should be run before each middleware
			sails.emit('router:route', {
				req: req,
				res: res,
				next: next
			});

			// Trigger original middleware function
			fn(req, res, next);
		};

		// If verb is not specified, the route should be cloned to all verbs
		sails.router._app[verb || 'all'](path, enhancedFn);

		// Emit an event to make hooks aware that a route was bound
		// (this allows hooks to handle routes directly if they want to)
		sails.emit('router:bind', {
			path	: path,
			target	: _.clone(enhancedFn),
			verb	: verb
		});

		// e.g. with Express, the handler for this event looks like:
		// sails.express.app[verb || 'all'](path, target);	
	}

	


	/**
	 * Right now we just return the "middleware" property of the route config, expecting it to be a function.
	 * In the future parseMiddleware will handle string values for "middleware", as well as config options 
	 * such as inputs and outputs.
	 *
	 * @api private
	 */

	function parseMiddleware(target) {
		return target.middleware;
	}


	function logInvalidRouteError (path, target, verb) {

		sails.log.error(
			(verb ? verb + ' ' : ''),
			path,
			':: Ignoring invalid attempt to bind route to non-function:',
			util.inspect(target)
		);
	}

};
