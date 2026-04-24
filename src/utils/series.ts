export function getSeriesKey(title: string): string {
	return title.replace(/\s*\(\d+\)\s*$/, '').trim();
}

export function getSeriesNum(title: string): number {
	const m = title.match(/\((\d+)\)\s*$/);
	return m ? parseInt(m[1]) : 0;
}

export function splitTitle(title: string): { firstLine: string; secondLine: string } {
	const words = title.split(' ');
	const mid = Math.ceil(words.length / 2);
	return {
		firstLine: words.slice(0, mid).join(' '),
		secondLine: words.slice(mid).join(' '),
	};
}
