/**
 * Sökrymden sträcker sig utanför det vi har vägdata för.
 *
 * Det här är INTE en krasch. Det är ett ärligt svar på en fråga vi ännu inte kan svara på,
 * och användaren ska få höra det på svenska — inte "internt fel", som är kod för "vi vet
 * inte vad som hände", när vi vet exakt vad som hände.
 *
 * Att bara hämta rutorna på plats vore fel: ellipsen för en 20-milstur spänner hundratals
 * rutor, och att bygga dem tar minuter. En användare som väntar fyra minuter på en
 * ruttberäkning har slutat vänta efter trettio sekunder.
 */
export class OkartlagdRegion extends Error {
  constructor(readonly saknade: number) {
    super(
      'Vi har inte kartlagt vägarna hela vägen dit än. '
      + 'Prova ett närmare mål så länge.',
    );
    this.name = 'OkartlagdRegion';
  }
}
