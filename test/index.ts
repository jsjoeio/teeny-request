/**
 * @license
 * Copyright 2018 Google LLC. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as assert from 'assert';
import {describe, it, afterEach, beforeEach} from 'mocha';
import * as nock from 'nock';
import {Readable, PassThrough} from 'stream';
import * as sinon from 'sinon';
import {teenyRequest} from '../src';
import {TeenyStatistics, TeenyStatisticsWarning} from '../src/TeenyStatistics';
import {pool} from '../src/agents';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const HttpProxyAgent = require('http-proxy-agent');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const HttpsProxyAgent = require('https-proxy-agent');

nock.disableNetConnect();
const uri = 'https://example.com';

function mockJson() {
  return nock(uri).get('/').reply(200, {hello: '🌍'});
}

function mockError() {
  return nock(uri).get('/').replyWithError('mock err');
}

describe('teeny', () => {
  const sandbox = sinon.createSandbox();
  let emitWarnStub: sinon.SinonStub;
  let statsStub: sinon.SinonStubbedInstance<TeenyStatistics>;

  beforeEach(() => {
    emitWarnStub = sandbox.stub(process, 'emitWarning');

    // don't mask other process warns
    emitWarnStub
      .callThrough()
      .withArgs(sinon.match.instanceOf(TeenyStatisticsWarning))
      .callsFake(() => {});

    // note: this stubs the already instantiated TeenyStatistics
    statsStub = sandbox.stub(teenyRequest.stats);
  });

  afterEach(() => {
    pool.clear();
    sandbox.restore();
    teenyRequest.resetStats();
    nock.cleanAll();
  });

  it('should get JSON', done => {
    const scope = mockJson();
    teenyRequest({uri}, (error, response, body) => {
      assert.ifError(error);
      assert.strictEqual(response.statusCode, 200);
      assert.ok(body.hello);
      scope.done();
      done();
    });
  });

  it('should set defaults', done => {
    const scope = mockJson();
    const defaultRequest = teenyRequest.defaults({timeout: 60000});
    defaultRequest({uri}, (error, response, body) => {
      assert.ifError(error);
      assert.strictEqual(response.statusCode, 200);
      assert.ok(body.hello);
      scope.done();
      done();
    });
  });

  it('response event emits object compatible with request module', done => {
    const reqHeaders = {fruit: 'banana'};
    const resHeaders = {veggies: 'carrots'};
    const scope = nock(uri).get('/').reply(202, 'ok', resHeaders);
    const reqStream = teenyRequest({uri, headers: reqHeaders});
    reqStream
      .on('response', res => {
        assert.strictEqual(res.statusCode, 202);
        assert.strictEqual(res.headers.veggies, 'carrots');
        assert.deepStrictEqual(res.request.headers, reqHeaders);
        assert.deepStrictEqual(res.toJSON(), {
          headers: resHeaders,
        });
        assert(res instanceof Readable);
        scope.done();
        done();
      })
      .on('error', done);
  });

  it('should include the request in the response', done => {
    const path = '/?dessert=pie';
    const scope = nock(uri).get(path).reply(202);
    const headers = {dinner: 'tacos'};
    const url = `${uri}${path}`;
    teenyRequest({url, headers}, (error, response) => {
      assert.ifError(error);
      const req = response.request;
      assert.deepStrictEqual(req.headers, headers);
      assert.strictEqual(req.href, url);
      scope.done();
      done();
    });
  });

  it('should not wrap the error', done => {
    const scope = nock(uri)
      .get('/')
      .reply(200, '🚨', {'content-type': 'application/json'});
    teenyRequest({uri}, err => {
      assert.ok(err);
      assert.ok(err!.message.match(/^invalid json response body/));
      scope.done();
      done();
    });
  });

  it('should include headers in the response', done => {
    const headers = {dinner: 'tacos'};
    const body = {hello: '🌍'};
    const scope = nock(uri).get('/').reply(200, body, headers);
    teenyRequest({uri}, (err, res) => {
      assert.ifError(err);
      assert.strictEqual(headers['dinner'], res.headers['dinner']);
      scope.done();
      done();
    });
  });

  it('should accept the forever option', done => {
    const scope = nock(uri).get('/').reply(200);
    teenyRequest({uri, forever: true}, (err, res) => {
      assert.ifError(err);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.strictEqual((res.request.agent as any).keepAlive, true);
      scope.done();
      done();
    });
  });

  it('should allow setting compress/gzip to true', done => {
    const reqheaders = {
      'Accept-Encoding': 'gzip,deflate',
    };

    const scope = nock(uri, {reqheaders}).get('/').reply(200);

    teenyRequest({uri, gzip: true}, err => {
      assert.ifError(err);
      scope.done();
      done();
    });
  });

  it('should allow setting compress/gzip to false', done => {
    const badheaders = ['Accept-Encoding'];

    const scope = nock(uri, {badheaders}).get('/').reply(200);

    teenyRequest({uri, gzip: false}, err => {
      assert.ifError(err);
      scope.done();
      done();
    });
  });

  const envVars = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'];
  for (const v of envVars) {
    it(`should respect ${v} environment variable for proxy config`, done => {
      sandbox.stub(process, 'env').value({[v]: 'https://fake.proxy'});
      const expectedBody = {hello: '🌎'};
      const scope = nock(uri).get('/').reply(200, expectedBody);
      teenyRequest({uri}, (err, res, body) => {
        scope.done();
        assert.ifError(err);
        assert.deepStrictEqual(expectedBody, body);
        assert.ok(res.request.agent instanceof HttpsProxyAgent);
        return done();
      });
    });
  }

  it('should create http proxy if upstream scheme is http', done => {
    sandbox.stub(process, 'env').value({http_proxy: 'https://fake.proxy'});
    const expectedBody = {hello: '🌎'};
    const scope = nock('http://example.com').get('/').reply(200, expectedBody);
    teenyRequest({uri: 'http://example.com'}, (err, res, body) => {
      scope.done();
      assert.ifError(err);
      assert.deepStrictEqual(expectedBody, body);
      assert.ok(res.request.agent instanceof HttpProxyAgent);
      return done();
    });
  });

  it('should use proxy if set in request options', done => {
    const expectedBody = {hello: '🌎'};
    const scope = nock(uri).get('/').reply(200, expectedBody);
    teenyRequest({uri, proxy: 'https://fake.proxy'}, (err, res, body) => {
      scope.done();
      assert.ifError(err);
      assert.deepStrictEqual(expectedBody, body);
      assert.ok(res.request.agent instanceof HttpsProxyAgent);
      return done();
    });
  });

  // see: https://github.com/googleapis/nodejs-storage/issues/798
  it('should not throw exception when piped through pumpify', async () => {
    const scope = mockJson();
    const stream = teenyRequest({uri}).pipe(new PassThrough());
    let content = '';
    for await (const data of stream) {
      content += data;
    }
    assert.deepStrictEqual(JSON.parse(content), {hello: '🌍'});
    scope.done();
  });

  it('should emit response event when called without callback', done => {
    const scope = mockJson();
    teenyRequest({uri}).on('response', res => {
      assert.ok(res);
      scope.done();
      return done();
    });
  });

  it('should pipe response stream to user', done => {
    const scope = mockJson();
    teenyRequest({uri})
      .on('error', done)
      .on('data', () => {
        scope.done();
        done();
      });
  });

  it('should not pipe response stream to user unless they ask for it', done => {
    const scope = mockJson();
    const stream = teenyRequest({uri}).on('error', done);
    stream.on('response', responseStream => {
      // We are using an internal property of Readable to get the number of
      // active readers. The property changed from `pipesCount: number` in
      // Node.js 12.x and below to `pipes: Array` in Node.js 13.x.
      let numPipes =
        responseStream.body._readableState.pipesCount ??
        responseStream.body._readableState.pipes?.length;
      assert.strictEqual(numPipes, 0);
      stream.on('data', () => {
        numPipes =
          responseStream.body._readableState.pipesCount ??
          responseStream.body._readableState.pipes?.length;
        assert.strictEqual(numPipes, 1);
        scope.done();
        done();
      });
    });
  });

  it('should expose TeenyStatistics instance', () => {
    assert.ok(teenyRequest.stats instanceof TeenyStatistics);
  });

  it('should allow resetting statistics', () => {
    const oldStats = teenyRequest.stats;
    teenyRequest.resetStats();
    assert.notStrictEqual(teenyRequest.stats, oldStats);
    assert.ok(teenyRequest.stats instanceof TeenyStatistics);
  });

  it('should keep the original stats options when resetting', () => {
    statsStub.getOptions.restore();
    statsStub.setOptions.restore();
    teenyRequest.stats.setOptions({concurrentRequests: 42});
    teenyRequest.resetStats();
    const newOptions = teenyRequest.stats.getOptions();
    assert.deepStrictEqual(newOptions, {concurrentRequests: 42});
  });

  it('should emit warning on too many concurrent requests', done => {
    statsStub.setOptions.restore();
    statsStub.requestStarting.restore();
    teenyRequest.stats.setOptions({concurrentRequests: 1});

    const scope = mockJson();
    teenyRequest({uri}, () => {
      assert.ok(emitWarnStub.calledOnce);
      scope.done();
      done();
    });
  });

  it('should track stats, callback mode, success', done => {
    const scope = mockJson();
    teenyRequest({uri}, () => {
      assert.ok(statsStub.requestStarting.calledOnceWithExactly());
      assert.ok(statsStub.requestFinished.calledOnceWithExactly());
      scope.done();
      done();
    });
  });

  it('should track stats, callback mode, failure', done => {
    const scope = mockError();
    teenyRequest({uri}, err => {
      assert.ok(err);
      assert.ok(statsStub.requestStarting.calledOnceWithExactly());
      assert.ok(statsStub.requestFinished.calledOnceWithExactly());
      scope.done();
      done();
    });
  });

  it('should track stats, stream mode, success', done => {
    const scope = mockJson();
    const readable = teenyRequest({uri});
    assert.ok(statsStub.requestStarting.calledOnceWithExactly());

    readable.once('response', () => {
      assert.ok(statsStub.requestFinished.calledOnceWithExactly());
      scope.done();
      done();
    });
  });

  it('should track stats, stream mode, failure', done => {
    const scope = mockError();
    const readable = teenyRequest({uri});
    assert.ok(statsStub.requestStarting.calledOnceWithExactly());

    readable.once('error', err => {
      assert.ok(err);
      assert.ok(statsStub.requestFinished.calledOnceWithExactly());
      scope.done();
      done();
    });
  });

  it('should accept a Buffer as the body of a request', done => {
    const scope = nock(uri).post('/', 'hello').reply(200, '🌍');
    teenyRequest(
      {uri, method: 'POST', body: Buffer.from('hello')},
      (error, response, body) => {
        assert.ifError(error);
        assert.strictEqual(response.statusCode, 200);
        assert.strictEqual(body, '🌍');
        scope.done();
        done();
      }
    );
  });

  it('should accept a plain string as the body of a request', done => {
    const scope = nock(uri).post('/', 'hello').reply(200, '🌍');
    teenyRequest(
      {uri, method: 'POST', body: 'hello'},
      (error, response, body) => {
        assert.ifError(error);
        assert.strictEqual(response.statusCode, 200);
        assert.strictEqual(body, '🌍');
        scope.done();
        done();
      }
    );
  });

  it('should accept json as the body of a request', done => {
    const body = {hello: '🌍'};
    const scope = nock(uri).post('/', JSON.stringify(body)).reply(200, '👋');
    teenyRequest({uri, method: 'POST', json: body}, (error, response, body) => {
      assert.ifError(error);
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(body, '👋');
      scope.done();
      done();
    });
  });

  // TODO multipart is broken with 2 strings
  // see: https://github.com/googleapis/teeny-request/issues/168
  it.skip('should track stats, multipart mode, success', done => {
    const scope = mockJson();
    teenyRequest(
      {
        method: 'POST',
        headers: {},
        multipart: [{body: 'foo'}, {body: 'bar'}],
        uri,
      },
      () => {
        assert.ok(statsStub.requestStarting.calledOnceWithExactly());
        assert.ok(statsStub.requestFinished.calledOnceWithExactly());
        scope.done();
        done();
      }
    );
  });

  it.skip('should track stats, multipart mode, failure', done => {
    const scope = mockError();
    teenyRequest(
      {
        method: 'POST',
        headers: {},
        multipart: [{body: 'foo'}, {body: 'bar'}],
        uri,
      },
      err => {
        assert.ok(err);
        assert.ok(statsStub.requestStarting.calledOnceWithExactly());
        assert.ok(statsStub.requestFinished.calledOnceWithExactly());
        scope.done();
        done();
      }
    );
  });
});
