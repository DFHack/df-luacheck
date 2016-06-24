var fs = require('fs');
var path = require('path');
var luaparser = require('./luaparse');
var parseXml = require('xml2js').parseString;
var chalk = require('chalk');
var _process = require('process');

var ensureArray = function(a) {
	if (!a)
		return [];

	if (!(a instanceof Array))
		return [a];

	return a;
};

var rootctx = JSON.parse(fs.readFileSync('ctx.json'));

var mainfn = _process.argv[_process.argv.length-1];
var basedir = path.dirname(mainfn);
var incpath = [ '/home/vit/c9workspace/dfremote' ];
var reqignore = [ 'remote.utf8.utf8data', 'remote.utf8.utf8', 'remote.JSON', 'remote.MessagePack', 'remote.underscore', 'gui', 'utils', 'compat' ];
var fnstocheck = [];

var src = fs.readFileSync(mainfn).toString();
var ast = luaparser.parse(src, { comments:true, locations:true, ranges:true });
var srcstack = [ { src:src, fn:mainfn, comments:ast.comments } ];
// console.log(JSON.stringify(ast,null,2));
console.log('---------------------------');

function findtype(name, ctx) {
	if (ctx.types[name])
		return ctx.types[name];

	if (ctx.parent)
		return findtype(name, ctx.parent);
}

function findfn(name, ctx) {
	if (name.substr(0,3) == 'df.') {
		var dot = name.lastIndexOf('.');
		if (dot != -1) {
			var t = expandtype(name.substr(0, dot), ctx);
			var n = name.substr(dot+1);
			if (t && t != '__unknown') {
				for (var o = t; o; o = expandtype(o._super,ctx)) {
					if (o._methods && o._methods[n])
						return o._methods[n];
				}
			}
		}
	}
	
	if (ctx.types && ctx.types[name] && ctx.types[name]._type == 'function')
		return ctx.types[name];

	if (ctx.functions && ctx.functions[name])
		return ctx.functions[name];

	if (ctx.parent)
		return findfn(name, ctx.parent);
}

function findguess(name, ctx) {
	if (ctx.guesses && ctx.guesses[name])
		return ctx.guesses[name];

	if (ctx.parent)
		return findguess(name, ctx.parent);
}


function expandtype(name, ctx) {
	if (name == 'number' || name == 'string' || name == 'bool' || name == 'none' || name == 'null')
		return name;
	
	if (typeof name == 'string') {
		var q = findtype(name, ctx);
		if (q)
			return q;
			
		var a = name.split('.');
		var t = findtype(a[0], ctx);// ctx.types.a[0];
		for (var j = 1; j < a.length; j++)
		{
			//TODO: not needed
			/*var o = t;
			var q;
			do {
				q = o[a[j]]
				console.log('will try super', o._super);
				o = o._super && findtype(o._super, ctx);
			} while(o && !t);*/
			t = t[a[j]];
		}
		return t;
	}

	return name;
}

function checktype(expr, ctx, opts) {
	//console.log('checking ',expr,ctx);
	opts = opts || {};

	if (expr.type == 'IndexExpression')
	{
		var t = checktype(expr.base, ctx);
		if (t == '__unknown') {
			err(expr.loc.start.line, 'type of expression is unknown', chalk.bold(sub(expr.base.range)));
			return '__unknown';
		}
		var idxt = checktype(expr.index, ctx);
		// console.log('==',t);
		if (t._array)
			return expandtype(t._array, ctx);
	}

	if (expr.type == 'MemberExpression')
	{
		var baset = checktype(expr.base, ctx);

		//TODO: need to update parent object type in context for abstract types
		/*if (baset._type == 'df.viewscreen' && !baset[expr.identifier.name]) {
			if (expr.base.type == 'Identifier') {
				var g = findguess(expr.identifier.name, ctx);
				if (g) {
					baset = expandtype(g, ctx);
				}
			}
		}
		
		if (baset == '__unknown') {
			var g = findguess(expr.identifier.name, ctx);
			if (g) {
				console.log('will return guess',g);
				return expandtype(g, ctx);
			}
			err(expr.loc.start.line, 'type of expression is unknown', chalk.bold(sub([expr.base.range[0], expr.identifier.range[0]-1])));

			return '__unknown';
		}*/

		var t = null;
		for (var o = baset; o && !t; o = expandtype(o._super,ctx)) {
			t = o[expr.identifier.name]
		}

		if (!t && baset._sub) {
			for (var j in baset._sub) {
				var subt = expandtype(baset._sub[j], ctx);
				t = subt[expr.identifier.name];
				if (t) {
					warn(expr.loc.start.line, 'using subclass', chalk.bold(subt._type), 'for base class', chalk.bold(baset._type), 'and field', chalk.bold(expr.identifier.name));
					//TODO: update context, track guesses, inform about conflicts
					break;
				}
			}
		}
		
		if (!t) {
			if (baset._type == '__df')
				err(expr.loc.start.line, 'type', chalk.bold('df.'+expr.identifier.name), 'does not exist');
			else if (baset._type == '__global')
				err(expr.loc.start.line, 'global', chalk.bold(expr.identifier.name), 'does not exist');
			else if (baset._enum)
				err(expr.loc.start.line, 'value', chalk.bold(expr.identifier.name), 'does not exist in enum', chalk.bold(baset._type));
			else {
				err(expr.loc.start.line, 'field', chalk.bold(expr.identifier.name), 'does not exist in', chalk.bold(sub([expr.base.range[0], expr.identifier.range[0]-1])), 'of type', chalk.bold(baset._type||baset));
			}
			return '__unknown';
		}

		return expandtype(t, ctx) || '__unknown';
	}

	if (expr.type == 'Identifier') {
		return expandtype(expr.name, ctx) || '__unknown';
	}

	if (expr.type == 'StringLiteral') {
		return 'string';
	}

	if (expr.type == 'BooleanLiteral') {
		return 'bool';
	}

	if (expr.type == 'NumericLiteral') {
		return 'number';
	}

	if (expr.type == 'NilLiteral') {
		return 'null';
	}
	
	if (expr.type == 'FunctionDeclaration') {
		expr._ctx = ctx;
		expr._src = srcstack[srcstack.length-1];
		return { _type:'function', _node:expr, _ctx:ctx, _src:srcstack[srcstack.length-1] };
	};

	if (expr.type == 'CallExpression') {
		return fntype(expr, ctx);
	}
	
	if (expr.type == 'StringCallExpression' && expr.base.type == 'MemberExpression' && flatten(expr.base,ctx) == 'df.new') {
		var t = expr.argument.value;
		return { value: expandtype(t) };
	}
	
	if (expr.type == 'StringCallExpression' && expr.base.name == 'require') {
		if (reqignore.indexOf(expr.argument.value) == -1)
		{
			var src = null;
			for (var i = 0; i < incpath.length; i++) {
				try {
					var fn = incpath[i] + '/' + expr.argument.value.split('.').join('/') + '.lua';
					src = fs.readFileSync(fn).toString();
				} catch (e) {
					err(expr.loc.start.line, 'could not require', expr.argument.value);
				}
			}
			
			if (src) {
				var ast = luaparser.parse(src, { comments:true, locations:true, ranges:true });		
				srcstack.push({src:src, fn:fn, comments:ast.comments});
				process(ast.body, ctx);
				srcstack.pop();
			}
		} else {
			if (expr.argument.value == 'remote.MessagePack')
				return rootctx.types.mp;
		}
		
		return 'none';
	}

	if (expr.type == 'BinaryExpression') {
		var t1 = checktype(expr.left, ctx);
		var t2 = checktype(expr.right, ctx);
		
		var res;
		var op = expr.operator;
		if (op == '..')
			res = 'string';
		else if (op == '+' || op == '-' || op == '/' || op == '*')
			res = 'number';
		else
			res = 'bool';
		
		if (t1 == '__unknown') 
			warn(expr.loc.start.line, 'type of operand',chalk.bold(sub(expr.left.range)), 'is unknown, assuming the result is', chalk.bold(res));
		if (t2 == '__unknown')
			warn(expr.loc.start.line, 'type of operand',chalk.bold(sub(expr.right.range)), 'is unknown, assuming the result is', chalk.bold(res));

		return res;
	}

	//TODO: if this is inside if condition, return bool and don't show warnings
	if (expr.type == 'LogicalExpression') {
		var t1 = checktype(expr.left, ctx, opts);
		var t2 = checktype(expr.right, ctx, opts);

		var res = 'bool';
		if (!opts.in_if) {
			/*if (t1 != 'bool' && t1 != 'null' && t1 != '__unknown')
				res = t1;
			else*/
			if (expr.operator == 'and') { 
				//if (t2 != 'bool' && t2 != 'null' && t2 != '__unknown')
					res = t2;
				//else
					//res = t1;
			} else if (expr.operator == 'or') {
				if ((t1 != 'bool' && t1 != 'null' && t1 != '__unknown') || t2 == '__unknown')
					res = t1;
				else
					res = t2;
			}
			
			if (t1 == '__unknown') 
				warn(expr.loc.start.line, 'type of operand',chalk.bold(sub(expr.left.range)), 'is unknown, assuming the result is', chalk.bold(res._type||res));
			if (t2 == '__unknown')
				warn(expr.loc.start.line, 'type of operand',chalk.bold(sub(expr.right.range)), 'is unknown, assuming the result is', chalk.bold(res._type||res));
		}

		// console.log(expr.loc.start.line,expr.operator,t1._type||t1,t2._type||t2,'->',res._type||res);
		return res;
	}

	if (expr.type == 'UnaryExpression') {
		var res;
		var op = expr.operator;
		if (op == '-') //todo: check operand type
			res = 'number';
		else if (op == '#') //todo: check operand type
			res = 'number';
		else if (op == 'not')
			res = 'bool';
		else
			res = '__unknown';

		var t1 = checktype(expr.argument, ctx);
		if (t1 == '__unknown' && !opts.in_if)
			warn(expr.loc.start.line, 'type of expression',chalk.bold(sub(expr.argument.range)), 'is unknown, assuming the result is', res);

		return res;
	}

	if (expr.type == 'TableConstructorExpression') {
		//console.log(expr.fields);
		if (!expr.fields.length)
			return { _type:'custom' };
			
		if (expr.fields[0].type == 'TableValue') {
			return { _array:checktype(expr.fields[0].value,ctx)||'__undefined', _type:'custom' };
		}
		
		//TODO: key-value pairs
		return { _type:'custom' };
	}

	return '__unknown';
}

function flatten(expr, ctx) {
	if (typeof expr == 'string')
		return expr;

	if (expr.type == 'Identifier')
		return expr.name;
		
	if (expr.type == 'CallExpression')
		return '__unknown';
		
	if (expr.indexer == ':') {
		var t = checktype(expr.base, ctx)
		if (t == '__unknown') {
			console.log('UNKNOWN');
		}
		
		return (t._type || t) + '.' + expr.identifier.name;
	}

	return flatten(expr.base) + expr.indexer + expr.identifier.name;
}

function fntype(call, ctx) {
	var fnname = null;
	if (call.base.type == 'Identifier') {
		fnname = call.base.name;
	} else if (call.base.type == 'MemberExpression') {
		fnname = flatten(call.base, ctx);
	}
	
	/*if (fnname.indexOf(':') != -1) {
		var a = fnname.split(':');
		var objname = a[0];
		var mname = a[1];
		var t = expandtype(objname, ctx) || '__unknown';
		if (t == '__unknown') {
			err(call.loc.start.line, 'unknown object', chalk.bold(objname));
			return '__unknown';
		}
		fnname = t + '.' + mname;
	}*/
	
	if (fnname.match('\\.delete$'))
		return 'none';
		
	//TODO: check that assignment is correct somehow ?
	if (fnname.match('\\.assign'))
		return 'none';

	if (fnname.match('\\.new')) 
		return expandtype(fnname.slice(0, -4), ctx);

	if (fnname.match('\\[\\]\\.(insert|delete)$'))
		return 'none';

	if (fnname == 'utils.binsearch') {
		var t = checktype(call.arguments[0], ctx);
		if (t && t._array)
			return expandtype(t._array, ctx);
	}
		
	// console.log(fnname, call.arguments);
	// call.arguments.forEach(function(a) {
	// 	console.log(checktype(a, ctx));
	// });
	
	if (fnname == 'pcall') {
		var a0 = checktype(call.arguments[0], ctx);
		var fn = a0._node;
		var ctx2 = { types:{}, parent:a0._ctx };
	
		for (var k = 0; k < fn.parameters.length; k++) {
			if (call.arguments.length > k + 1) {
				var t = checktype(call.arguments[k+1], ctx);
				ctx2.types[fn.parameters[k].name] = t;
			} else {
				ctx2.types[fn.parameters[k].name] = 'null';
			}
		}
		// console.log(ctx2);
		
		srcstack.push(a0._src);
		var q = process(fn.body, ctx2);
		srcstack.pop();

		return q;
	}

	var fn = findfn(fnname,ctx);
	if (!fn) {
		err(call.loc.start.line, 'unknown function', chalk.bold(fnname));
		return '__unknown';
	}

	if (typeof fn == 'string')
		return expandtype(fn, ctx);
		
	if (fn._type == 'function')
		fn = fn._node;

	var ctx2 = { types:{}, parent:fn._ctx };
	for (var k = 0; k < fn.parameters.length; k++) {
		if (call.arguments.length > k) {
			var t = checktype(call.arguments[k], ctx);
			ctx2.types[fn.parameters[k].name] = t;
		} else {
			ctx2.types[fn.parameters[k].name] = 'null';
		}
	}

	srcstack.push(fn._src);
	var q = process(fn.body, ctx2);
	srcstack.pop();

	// console.log(fnname, 'returns', q);
	return q;
}

function process(body, ctx) {
	var rettype = null;

	body.forEach(function(b) {
		if (b.type == 'FunctionDeclaration') {
			ctx.functions = ctx.functions || {};
			ctx.functions[b.identifier.name] = b;
			ctx.functions[b.identifier.name]._src = srcstack[srcstack.length-1];
			ctx.functions[b.identifier.name]._ctx = ctx;
			
			var cs = srcstack[srcstack.length-1].comments;
			if (cs) {
				for (var j = 0; j < cs.length; j++) {
					var c = cs[j];
					
					if (c.loc.start.line == b.loc.start.line-1 && c.value.substr(0,9) == 'luacheck:') {
						var inp = c.value.match(/in=([^\s]*)/);
						var outp = c.value.match(/out=([^\s]+)/);
						
						if (inp)
							fnstocheck.push({node:b, inp:inp});
					}
				}
			}
		}

		if (b.type == 'LocalStatement') {
			var cs = srcstack[srcstack.length-1].comments;
			var as = null;
			if (cs) {
				for (var j = 0; j < cs.length; j++) {
					var c = cs[j];
					if (c.loc.start.line == b.loc.start.line && c.value.substr(0,3) == 'as:') {
						var m = c.value.match(/as:\s*([^\s]+)/);
						if (m)
							as = m[1].split(',');
					}
				}
			}

			for (var j = 0; j < b.variables.length; j++) {
				var n = b.variables[j].name;
				if (b.init.length > j) {
					var t = checktype(b.init[j], ctx);
	
					if (as && as.length > 0)
						t = expandtype(as[0], ctx);

					if (t == '__unknown')
						err(b.loc.start.line, 'type of expression is unknown', chalk.bold(sub(b.init[j].range)));
					ctx.types[n] = t;
				} else 
					ctx.types[n] = 'null';
			}
		}

		if (b.type == 'AssignmentStatement') {
			if (b.variables[0].type == 'Identifier') {
				var n = b.variables[0].name;
				var t = checktype(b.init[0],ctx);
								
				if (t == '__unknown')
					err(b.loc.start.line, 'type of expression is unknown', chalk.bold(sub(b.init[0].range)));
	
				else {
					// Since it may be a var not local to the current context,
					// we need to find closest one having this var and update its type
					var found = false;
					for (var c = ctx; c; c = c.parent) {
						if (c.types[n]) {
							if (c.types[n] != 'null' && c.types[n] != t && t != '__unknown' && t != 'null' &&
								c.types[n]._type != 'custom') {
								err(b.loc.start.line, 'assigning', chalk.bold(sub(b.init[0].range)), 'of type', chalk.bold(t&&t._type||t), 'to', chalk.bold(b.variables[0].name), 'of type', chalk.bold(c.types[n]._type||c.types[n]));
							}
							c.types[n] = t;
							found = true;
							break;
						}
					}
		
					if (!found) {
						warn(b.loc.start.line, 'assignment to global/unknown var', b.variables[0].name);
						ctx.types[n] = t;
					}
				}				

			} else if (b.variables[0].type == 'MemberExpression') {
				var lt = checktype(b.variables[0], ctx)
				var rt = checktype(b.init[0],ctx);
				if (lt == '__unknown')
					err(b.loc.start.line, 'type of expression is unknown', chalk.bold(sub(b.variables[0].range)));
				if (rt == '__unknown')
					err(b.loc.start.line, 'type of expression is unknown', chalk.bold(sub(b.init[0].range)));
				if (lt != '__unknown' && rt != '__unknown' && lt != rt && rt != 'null') {
					err(b.loc.start.line, 'assigning', chalk.bold(sub(b.init[0].range)), 'of type', chalk.bold(rt._type||rt), 'to', chalk.bold(sub(b.variables[0].range)), 'of type', chalk.bold(lt._type||lt));
				}
				//console.log(, b.variables[0], t);
			
			} else if (b.variables[0].type == 'IndexExpression') {
				//TODO: check left side
				
				var rt = checktype(b.init[0],ctx);
				if (rt == '__unknown')
					err(b.loc.start.line, 'type of expression is unknown', chalk.bold(sub(b.init[0].range)));
			} else {
				console.log(b);
				throw new Error('unknown left side', b);
			}
		}

		if (b.type == 'ForGenericStatement') {
			if (b.iterators[0].base.name == 'ipairs') {
				var ctx2 = { parent:ctx, types:{} };
				var t = checktype(b.iterators[0].arguments[0],ctx);
				// console.log('$$$',b.iterators[0].arguments[0], t);
				//if (t == '__unknown')
				//	err(b.loc.start.line, 'skipped loop');
				//else
				{
					ctx2.types[b.variables[0].name] = 'number';
					ctx2.types[b.variables[1].name] = expandtype(t._array, ctx);
					rettype = process(b.body, ctx2) || rettype;
				}
			} else {
				warn(b.loc.start.line, 'unsupported for loop');
			}
		}

		if (b.type == 'IfStatement') {
			b.clauses.forEach(function(c) {
				if (c.condition) {
					var t = checktype(c.condition, ctx, { in_if:true });
					// if (t == '__unknown')
					// 	err(b.loc.start.line, 'type of expression is unknown', chalk.bold(sub(c.condition.range)));
				}
	
				var ctx2 = { parent:ctx, types:{} };			
				rettype = process(c.body, ctx2) || rettype;
			});
		}

		if (b.type == 'ReturnStatement') {
			if (b.arguments.length) {
				var t = checktype(b.arguments[0], ctx);
				if (t != 'null')
					rettype = t;
			}
		}

		if (b.type == 'CallStatement') {
			checktype(b.expression, ctx);
		}

	});

	return rettype;
}

function sub(range)
{
	return srcstack[srcstack.length-1].src.substring(range[0], range[1]);
}

function err(line)
{
	var args = Array.prototype.slice.call(arguments);
	var fn = srcstack[srcstack.length-1].fn.split('/').slice(-1)[0];
	args.splice(0, 1, chalk.red('ERROR ' + fn + ':' + line));
	console.log.apply(null, args);
}

function warn(line)
{
	var args = Array.prototype.slice.call(arguments);
	var fn = srcstack[srcstack.length-1].fn.split('/').slice(-1)[0];
	args.splice(0, 1, chalk.yellow('WARN  ' + fn + ':' + line));
	console.log.apply(null, args);
}

process(ast.body, rootctx);

fnstocheck.forEach(function(fn) {
	var b = fn.node;
	var ctx = b._ctx;
	var inp = fn.inp;
	var argtypes = inp[1].split(',');

	var ctx2 = { types:{}, parent:ctx };
	
	for (var k = 0; k < b.parameters.length; k++) {
		if (argtypes.length > k) {
			var t = expandtype(argtypes[k], ctx);
			ctx2.types[b.parameters[k].name] = t;
		} else {
			ctx2.types[b.parameters[k].name] = 'null';
		}
	}

	srcstack.push(b._src);
	process(b.body, ctx2);
	srcstack.pop();
});

//console.log(functions);
