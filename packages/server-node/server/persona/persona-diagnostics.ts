// 仅供 persona-probe 输出的人工/简单诊断：标记 low-information generic clue。
// 这不是线上拦截规则，不接入 DescriptionQualityGate，也不参与裁决。

export interface LowInformationClueMatch {
  phrase: string;
}

const GENERIC_CLUE_PATTERNS: ReadonlyArray<{ phrase: string; regex: RegExp }> = [
  { phrase: '很常见/随处可见', regex: /很常见|特别常见|相当常见|随处可见|到处都有|哪儿都有/ },
  { phrase: '与生活有关', regex: /(和|与|跟)生活(有关|有联系|紧密)/ },
  { phrase: '大家都见过/接触过', regex: /大家都(见过|接触过|用过|坐过|吃过)|大家可能(接触|见过|用过)|很多人(会)?(接触|见过|用到)/ },
  { phrase: '平时会遇到', regex: /平时(很)?容易(遇到|碰到)|平时会遇到|日常生活中(经常|常常)?(遇到|见到|碰到)|经常(能)?遇到/ },
  { phrase: '是一个东西/很普遍', regex: /是一种东西|是个东西|很普遍|太普遍了/ },
];

export function flagLowInformationClue(text: string): LowInformationClueMatch[] {
  const matches: LowInformationClueMatch[] = [];
  for (const { phrase, regex } of GENERIC_CLUE_PATTERNS) {
    if (regex.test(text)) matches.push({ phrase });
  }
  return matches;
}
