import twitterText from 'twitter-text';

export function xWeightedLength(text: string): number {
  return twitterText.parseTweet(text.normalize('NFC')).weightedLength;
}
export function assertXText(text: string): void {
  if (!twitterText.parseTweet(text.normalize('NFC')).valid) throw new Error('X text and tags must fit 280 weighted characters; Chinese characters and emoji count as two, and valid URLs count as 23.');
}
