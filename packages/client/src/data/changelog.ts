export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export const changelog: ChangelogEntry[] = [
  {
    version: '0.8.19',
    date: '2026-11-07',
    changes: [
      'changelog.new_0_8_19_1',
    ],
  },
  {
    version: '0.8.18',
    date: '2026-11-07',
    changes: [
      'changelog.new_0_8_18_1',
      'changelog.new_0_8_18_2',
      'changelog.new_0_8_18_3',
      'changelog.new_0_8_18_4',
      'changelog.new_0_8_18_5',
      'changelog.new_0_8_18_6',
      'changelog.new_0_8_18_7',
    ],
  },
  {
    version: '0.8.17',
    date: '2026-11-05',
    changes: [
      'changelog.new_0_8_17_1',
      'changelog.new_0_8_17_2',
      'changelog.new_0_8_17_3',
    ],
  },
]
