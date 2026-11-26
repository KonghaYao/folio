import { expect, test } from 'bun:test';
import { footprint, readSample, type Sample } from './ink';

test('tiltX and tiltY yield orthogonal pencil footprints at equal pressure', () => {
  const settings = { width: 18, brush: 'pencil' as const };
  const x = footprint([0, 0, 0.8, 65, 0, 0, 0], settings),
    y = footprint([0, 0, 0.8, 0, 65, 0, 0], settings);
  expect(x.a).toBeCloseTo(y.a);
  expect(x.a / x.b).toBeGreaterThan(3);
  expect(y.angle - x.angle).toBeCloseTo(Math.PI / 2);
});

test('pressure zero and barrel pressure remain independent at contact', () => {
  const sample = readSample(
    { pressure: 0, tiltX: 90, tiltY: 0, twist: 0, tangentialPressure: -0.3 } as PointerEvent,
    3,
    -5,
  );
  expect(sample).toEqual([3, -5, 0, 90, 0, 0, -0.3]);
  const settings = { width: 12, brush: 'pencil' as const };
  const normal: Sample = [0, 0, 0.7, 65, 0, 0, 0];
  expect(footprint(sample, settings).a).toBeFinite();
  expect(footprint([...normal.slice(0, 6), 1] as Sample, settings).b).toBeGreaterThan(
    footprint(normal, settings).b,
  );
});

test('devices exposing altitude and azimuth retain side orientation', () => {
  const event = {
    pressure: 0.7,
    altitudeAngle: Math.PI / 6,
    azimuthAngle: Math.PI / 2,
  } as PointerEvent;
  const sample = readSample(event, 0, 0);
  expect(sample[3]).toBeCloseTo(0);
  expect(sample[4]).toBeCloseTo(60);
});
