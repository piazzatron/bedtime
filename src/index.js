import App from './components/app';

if (window.Twitch) {
  const log = console.log
  const error = console.error
  const warn = console.warn
  window.console.log = (msg) => window.Twitch.ext.rig.log(msg) || log(msg)
  window.console.warn = (msg) => window.Twitch.ext.rig.log(msg) || warn(msg)
  window.console.error = (msg) => window.Twitch.ext.rig.log(msg) || error(msg)
}
export default App;
