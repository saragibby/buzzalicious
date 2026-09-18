import { ConfigError, type Config, getConfig } from './config';

/**
 * Boot-time config loading with a failure mode a human can act on.
 *
 * The prototype's silent fallbacks meant a deploy missing `FRONTEND_URL` started
 * successfully and then redirected real users to `https://your-app.herokuapp.com`. The
 * only acceptable behaviour is to refuse to start and say exactly which variables are
 * wrong — which is why this writes to stderr directly rather than through Pino: the
 * logger itself needs config, so it does not exist yet.
 */
export function loadConfigOrExit(): Config {
  try {
    return getConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(
        [
          '',
          '  Buzzalicious failed to start: the environment is not valid.',
          '',
          ...error.problems.map((problem) => `    ✗ ${problem}`),
          '',
          '  Set these in backend/.env locally, or as Heroku config vars in a deployed',
          '  environment. See backend/.env.example for a description of each.',
          '',
        ].join('\n'),
      );
      process.exit(1);
    }
    throw error;
  }
}
