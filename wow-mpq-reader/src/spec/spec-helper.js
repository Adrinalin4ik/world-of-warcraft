import chai from 'chai';
import sinon from 'sinon';
import bridge from 'sinon-chai';

chai.use(bridge);

beforeEach(function() {
  this.sandbox = sinon.sandbox.create();
});

afterEach(function() {
  this.sandbox.restore();
});

export const expect = chai.expect;
export const fixtures = 'spec/fixtures/';
export * as memo from 'memo-is';
export * as sinon from 'sinon';

