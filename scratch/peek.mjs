import { render } from 'pele'
import { flatten } from '../bin/herdr-diagram.mjs'
const s = flatten(render('usecase-beta\n  actor User\n  User e1@--> Login\n  e1@{ animate: true }\n', { fontFamily: 'Helvetica' }).svg)
console.log(JSON.stringify(s.slice(560, 760)))
