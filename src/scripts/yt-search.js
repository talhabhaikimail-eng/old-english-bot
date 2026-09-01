import yts from 'yt-search'
const r = await yts('superman theme')

const videos = r.videos.slice(0, 3)
videos.forEach(function (v) {
    // const views = String(v.views).padStart(10, ' ')
    console.log(v)
    // console.log(`${views} | ${v.title} (${v.timestamp}) | ${v.author.name}`)
})