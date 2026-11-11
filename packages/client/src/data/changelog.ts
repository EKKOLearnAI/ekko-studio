export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export const changelog: ChangelogEntry[] = [
  {
    version: '0.8.21',
    date: '2026-11-11',
    changes: [
      'changelog.new_0_8_21_1',
      'changelog.new_0_8_21_2',
      'changelog.new_0_8_21_3',
      'changelog.new_0_8_21_4',
      'changelog.new_0_8_21_5',
      'changelog.new_0_8_21_6',
    ],
  },
  {
    version: '0.8.20',
    date: '2026-11-09',
    changes: [
      'changelog.new_0_8_20_1',
      'changelog.new_0_8_20_2',
      'changelog.new_0_8_20_3',
      'changelog.new_0_8_20_4',
      'changelog.new_0_8_20_5',
      'changelog.new_0_8_20_6',
      'changelog.new_0_8_20_7',
    ],
  },
  {
    version: '0.8.19',
    date: '2026-11-07',
    changes: [
      'changelog.new_0_8_19_1',
    ],
  },
]
