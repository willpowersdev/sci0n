/**
 * Where the game folders live.
 *
 * The suites read real Sierra games, which cannot be redistributed, so
 * the location is configuration rather than something checked in: set
 * SCI_GAMES to a directory holding one folder per game (SQ3, KQ4, ...).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROOT = process.env.SCI_GAMES ?? join(homedir(), 'DOSGames', 'SIERRA');
