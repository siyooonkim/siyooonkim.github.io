export const categoryThemes: Record<string, { bg: string; accent: string; pattern: string }> = {
	'Essay': { bg: '#2a1f1a', accent: '#ffab91', pattern: 'waves' },
	'사이드 프로젝트': { bg: '#1a2e1a', accent: '#81c784', pattern: 'circles' },
	'개발일지': { bg: '#1a2340', accent: '#7aa2f7', pattern: 'dots' },
	'데이터베이스': { bg: '#2d1a3d', accent: '#bb86fc', pattern: 'lines' },
	'딥러닝': { bg: '#1a3333', accent: '#4dd0e1', pattern: 'grid' },
};

export const seriesThemes: Record<string, { bg: string; accent: string; pattern: string }> = {
	'cs-auto-chatbot': { bg: '#1a2340', accent: '#7aa2f7', pattern: 'dots' },
	'crm-improvement': { bg: '#1a3040', accent: '#73daca', pattern: 'grid' },
	'busbell': { bg: '#1a2e1a', accent: '#81c784', pattern: 'circles' },
	'iot-feeder': { bg: '#2a3a1a', accent: '#c6e070', pattern: 'waves' },
	'actionlog-optimization': { bg: '#2d1a3d', accent: '#bb86fc', pattern: 'lines' },
};

export const defaultTheme = { bg: '#2a2a2a', accent: '#9ec5f8', pattern: 'dots' };
