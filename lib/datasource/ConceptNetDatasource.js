/*
 * Copyright (c) 2023, IBM Research
 * Licensed under The MIT License [see LICENSE for details]
 */

let Datasource = require('@ldf/core').datasources.Datasource,
    SparqlJsonParser = require('sparqljson-parse').SparqlJsonParser,
    LRU = require('lru-cache');

const hash = require('object-hash'), fetch = require('node-fetch');

let DEFAULT_COUNT_ESTIMATE = { totalCount: 1e9, hasExactCount: false };
let ENDPOINT_ERROR = 'Error accessing ConceptNet endpoint';
let INVALID_JSON_RESPONSE = 'The endpoint returned an invalid JSON response.';
const xsd  = 'http://www.w3.org/2001/XMLSchema#';

class ConceptNetDatasource extends Datasource {
  constructor(options) {
    let supportedFeatureList = ['quadPattern', 'triplePattern', 'limit', 'offset', 'totalCount'];
    super(options, supportedFeatureList);

    this._countCache = new LRU({ max: 1000, ttl: 1000 * 60 * 60 * 3 });
    this._resolvingCountQueries = {};
    this._sparqlJsonParser = new SparqlJsonParser({ dataFactory: this.dataFactory });

    options = options || {};
    this._endpoint = this._endpointUrl = (options.endpoint || '').replace(/[\?#][^]*$/, '');
    this._mapping = options.mapping || '';
    this._baseUri = options.baseUri || 'http://conceptnet.io';
    this._languages = options.languages || [];
  }

  // Writes the results of the query to the given triple stream
  async _executeQuery(query, destination) {
    const pattern = this._createQuadPattern(query), self = this,
        uriQuery = this._createUriRequest(pattern, query.offset, query.limit),
        url = `${this._endpointUrl}${uriQuery}`;

    let json = '';
    let errored = false;
    let response;
    try {
      response = await fetch(url);
      for await (const chunk of response.body)
        json += chunk.toString();
    }
    catch (err) {
      return emitError({ message: err.message });
    }

    try {
      response = JSON.parse(json);
    }
    catch (e) {
      return emitError({ message: INVALID_JSON_RESPONSE });
    }

    if (!response.edges) return;

    for (const edge of response.edges) {
      if (!this._shouldFilterLanguage(edge)) {
        let binding = this._edge2quad(edge);
        binding = this._sparqlJsonParser.parseJsonBindings(binding);

        let triple = {
          subject:   binding.s || query.subject,
          predicate: binding.p || query.predicate,
          object:    binding.o || query.object,
          graph:     binding.g || query.graph,
        };
        destination._push(triple);
      }
    }
    destination.close();

    // Determine the total number of matching triples
    this._getTotalNumber(pattern).then((count) => {
      destination.setProperty('metadata', count);
    },
    emitError);

    function emitError(error) {
      if (!error || errored) return;
      errored = true;
      destination.emit('error', new Error(ENDPOINT_ERROR + ' ' + self._endpoint + ': ' + error.message));
    }
  }

  // Retrieves the (approximate) number of triples that match the pattern
  async _getTotalNumber(pattern) {
    // Try to find a cache match
    const cachePattern = hash(pattern);

    let cache = this._countCache, count = cache.get(cachePattern);
    if (count)
      return Promise.resolve({ totalCount: count, hasExactCount: true });

    // Immediately return the fallback URL if a count is already going on.
    if (this._resolvingCountQueries[cachePattern])
      return Promise.resolve(DEFAULT_COUNT_ESTIMATE);

    let uri = `${this._endpointUrl}/count${this._createUriRequest(pattern)}`;

    let response, json = '';
    try {
      response = await fetch(uri);
      for await (const chunk of response.body)
        json += chunk.toString();
    }
    catch (err) {
      return Promise.reject(new Error(err.message));
    }

    let result;

    try {
      result = JSON.parse(json);
    }
    catch (e) {
      return Promise.reject(new Error(INVALID_JSON_RESPONSE));
    }

    return new Promise(async (resolve, reject) => {
      this._resolvingCountQueries[cachePattern] = true;

      delete this._resolvingCountQueries[cachePattern];

      if (!result)
        reject(new Error('COUNT query failed.'));
      else {
        // Cache large values; small ones are calculated fast anyway
        if (result.numberOfEdges > 100000)
          cache.set(cachePattern, result.numberOfEdges);

        resolve({ totalCount: result.numberOfEdges, hasExactCount: true });
      }

      function resolveToDefault() { resolve(DEFAULT_COUNT_ESTIMATE); }
      // When no result arrives in time, send a default count
      // (the correct result might still end up in the cache for future use)
      setTimeout(resolveToDefault, 3000);
    });
  }

  // Complete the URI with parameters to access the desired data from the given pattern
  _createUriRequest(quadPattern, offset, limit) {
    let queryParams = '';

    if (quadPattern && Object.keys(quadPattern).length > 0) {
      if (quadPattern.subject) queryParams = `${queryParams}&start=${quadPattern.subject}`;
      if (quadPattern.predicate) queryParams = `${queryParams}&rel=${quadPattern.predicate}`;
      if (quadPattern.object) queryParams = `${queryParams}&end=${quadPattern.object}`;
      if (quadPattern.graph) queryParams = `${queryParams}&dataset=${quadPattern.graph}`;
    }

    if (offset) queryParams = `${queryParams}&offset=${offset}`;
    if (limit) queryParams = `${queryParams}&limit=${limit}`;

    return queryParams.startsWith('&') ? `?${queryParams.slice(1)}` : queryParams;
  }

  // Creates a quad pattern
  _createQuadPattern(quad) {
    let quadPattern = {};

    quad.subject && (quadPattern.subject = this._encodeObject(quad.subject));
    quad.predicate && (quadPattern.predicate = this._encodeObject(quad.predicate));
    quad.object && (quadPattern.object = this._encodeObject(quad.object));
    quad.graph && (quadPattern.graph = this._encodeObject(quad.graph));

    return quadPattern;
  }

  _shouldFilterLanguage(edge) {
    if (!this._languages || this._languages.length === 0) return false;

    const s = edge.start, o = edge.end;

    return ((s.hasOwnProperty('language') && !this._languages.includes(s.language)) ||
    (o.hasOwnProperty('language') && !this._languages.includes(o.language)));
  }

  _encodeObject(term) {
    switch (term.termType) {
    case 'NamedNode':
      return term.value.replace(this._baseUri, '');
    case 'BlankNode':
      return '_:' + term.value;
    case 'Variable':
      return '?' + term.value;
    case 'DefaultGraph':
      return '';
    case 'Literal':
      return this._convertLiteral(term);
    default:
      return null;
    }
  }

  _isURL(value) {
    try { return Boolean(new URL(value)); }
    catch (e) { return false; }
  }

  _convertLiteral(term) {
    if (!term)
      return '?o';
    else {
      return ((!/["\\]/.test(term.value)) ?  '"' + term.value + '"' : '"""' + term.value.replace(/(["\\])/g, '\\$1') + '"""') +
        (term.language ? '@' + term.language :
          (term.datatype && term.datatype.value !== xsd + 'string' ? '^^' + this._encodeObject(term.datatype) : this._forceTypedLiterals ? '^^<http://www.w3.org/2001/XMLSchema#string>' : ''));
    }
  }

  _edge2quad(edge) {
    let s = edge.start, p = edge.rel, o = edge.end;// , g = edge.dataset;

    let binding = {};
    if (typeof s !== 'string' && !(s instanceof String)) s = s['@id'];
    if (typeof p !== 'string' && !(p instanceof String)) p = p['@id'];
    if (typeof o !== 'string' && !(o instanceof String)) o = o['@id'];
    // if (typeof g !== 'string' && !(g instanceof String)) g = g['@id'];

    binding.s = { type: 'uri', value: this._isURL(s) ? s : `${this._baseUri}${s}` };
    binding.p = { type: 'uri', value: this._isURL(p) ? p : `${this._baseUri}${p}` };
    binding.o = { type: 'uri', value: this._isURL(o) ? o : `${this._baseUri}${o}` };
    // binding.g = { type: 'uri', value: this._isURL(g) ? g : `${this._baseUri}${g}` };

    return binding;
  }
}

module.exports = ConceptNetDatasource;
