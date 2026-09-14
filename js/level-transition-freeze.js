export class LevelTransitionFreeze {
  constructor() {
    this.game = null;
  }

  freeze(game) {
    if (!game || this.game === game) return false;
    this.game = game;
    game.pause?.();
    return true;
  }

  release(currentGame) {
    const frozenGame = this.game;
    this.game = null;
    if (!frozenGame || frozenGame !== currentGame) return false;
    frozenGame.resume?.();
    return true;
  }
}
