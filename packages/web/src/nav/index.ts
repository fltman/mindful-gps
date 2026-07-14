/**
 * Navigeringen — rösten, tystnaden, och var på rutten vi är.
 *
 * Ingen ruttning sker här. Modulen konsumerar en färdig `Route` och en ström av fixar,
 * och producerar tre saker: en position längs rutten, svenska meningar, och — när föraren
 * valt en annan väg — en beskrivning av vad en omruttning måste bevara.
 */

export {
  capitalize, curtPhrase, farText, isSilent, maneuverPhrase, nowText,
  offRouteText, roadLabel, shortPhrase, spokenDistance, startText,
} from './phrases.sv.js';

export {
  CHAIN_M, CueQueue, FAR_FAST_M, FAR_M, FAST_MS, NOW_M,
  chainsInto, cuesFor, farDistanceM, scheduleRoute,
  type CueKind, type ScheduledCue, type VoiceCue,
} from './schedule.js';

export {
  FÖRÅLDRAD_MS, SpeechVoice, Voice, audioElement, estimatedMs, primeAudio,
  type VoiceEngine,
} from './voice.js';

export {
  REACQUIRE_M, WINDOW_BACK_M, WINDOW_FWD_M, Follower, prepare,
  type FollowState, type FollowedRoute,
} from './follower.js';

export {
  AHEAD_MARGIN_M, NY_VÄG_MIN, OFF_ROUTE_M, OFF_ROUTE_S, OffRouteWatch,
  REROUTE_DEBOUNCE_MS, UTURN_ARC_DEG, UTURN_RADIUS_M,
  projectThrough, throughAhead,
  type NavPlan, type OffRouteInput, type RerouteRequest,
} from './offroute.js';

export {
  NavScreen, type NavScreenProps, type Nyhetsminne,
} from './NavScreen.js';
