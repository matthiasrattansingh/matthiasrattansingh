// The app's event calendar: data/events.json bound to the pure functions in events.js.
import calendar from '../data/events.json';
import * as ev from './events.js';

export const specialFor = (progress, date, cards) => ev.specialFor(progress, date, cards, calendar);
export const specialsLog = (progress, today, cards) => ev.specialsLog(progress, today, cards, calendar);
export { calendar };
