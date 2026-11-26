export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export const changelog: ChangelogEntry[] = [
  {
    version: '0.8.32',
    date: '2026-11-26',
    changes: [
      'changelog.new_0_8_32_1',
      'changelog.new_0_8_32_2',
      'changelog.new_0_8_32_3',
      'changelog.new_0_8_32_4',
    ],
  },
  {
    version: '0.8.31',
    date: '2026-11-24',
    changes: [
      'changelog.new_0_8_31_1',
      'changelog.new_0_8_31_2',
      'changelog.new_0_8_31_3',
      'changelog.new_0_8_31_4',
      'changelog.new_0_8_31_5',
      'changelog.new_0_8_31_6',
    ],
  },
  {
    version: '0.8.30',
    date: '2026-11-21',
    changes: [
      'changelog.new_0_8_30_1',
      'changelog.new_0_8_30_2',
      'changelog.new_0_8_30_3',
      'changelog.new_0_8_30_4',
      'changelog.new_0_8_30_5',
      'changelog.new_0_8_30_6',
    ],
  },
]
