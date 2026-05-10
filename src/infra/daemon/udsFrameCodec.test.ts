import {describe, expect, it} from 'vitest';
import {tryReadFrame, DEFAULT_MAX_FRAME_BYTES} from './udsFrameCodec';

function makeFrame(body: string): Buffer {
	const bodyBuf = Buffer.from(body, 'utf-8');
	return Buffer.concat([Buffer.from(`${bodyBuf.length}\n`, 'utf-8'), bodyBuf]);
}

describe('tryReadFrame', () => {
	it('returns null when buffer is empty', () => {
		expect(tryReadFrame(Buffer.alloc(0))).toBeNull();
	});

	it('returns null when only the length header is present', () => {
		expect(tryReadFrame(Buffer.from('5\n', 'utf-8'))).toBeNull();
	});

	it('returns null when body is incomplete', () => {
		expect(tryReadFrame(Buffer.from('5\nhi', 'utf-8'))).toBeNull();
	});

	it('reads a complete frame and returns the body', () => {
		const result = tryReadFrame(makeFrame('hello'));
		expect(result).not.toBeNull();
		expect(result!.ok).toBe(true);
		if (result && result.ok) {
			expect(result.body.toString('utf-8')).toBe('hello');
			expect(result.rest.length).toBe(0);
		}
	});

	it('returns the unconsumed tail in rest', () => {
		const frame = makeFrame('ab');
		const extra = Buffer.from('extra', 'utf-8');
		const result = tryReadFrame(Buffer.concat([frame, extra]));
		expect(result?.ok).toBe(true);
		if (result?.ok) {
			expect(result.rest.toString('utf-8')).toBe('extra');
		}
	});

	it('handles a zero-byte body', () => {
		const result = tryReadFrame(Buffer.from('0\n', 'utf-8'));
		expect(result?.ok).toBe(true);
		if (result?.ok) {
			expect(result.body.length).toBe(0);
		}
	});

	it('returns ok:false for a non-numeric length header', () => {
		const result = tryReadFrame(Buffer.from('not-a-number\nbody', 'utf-8'));
		expect(result?.ok).toBe(false);
		if (result && !result.ok) {
			expect(result.error).toMatch(/uds bad framing/);
		}
	});

	it('returns ok:false when body length exceeds maxBodyBytes', () => {
		const result = tryReadFrame(
			Buffer.from(`${DEFAULT_MAX_FRAME_BYTES + 1}\n`, 'utf-8'),
			DEFAULT_MAX_FRAME_BYTES,
		);
		expect(result?.ok).toBe(false);
	});

	it('accepts a custom maxBodyBytes', () => {
		const result = tryReadFrame(Buffer.from('10\nhellohello', 'utf-8'), 10);
		expect(result?.ok).toBe(true);
	});

	it('reads frames sequentially when chained on rest', () => {
		const combined = Buffer.concat([makeFrame('first'), makeFrame('second')]);
		const r1 = tryReadFrame(combined);
		expect(r1?.ok).toBe(true);
		if (r1?.ok) {
			expect(r1.body.toString()).toBe('first');
			const r2 = tryReadFrame(r1.rest);
			expect(r2?.ok).toBe(true);
			if (r2?.ok) expect(r2.body.toString()).toBe('second');
		}
	});
});
