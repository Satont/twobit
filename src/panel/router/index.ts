import Vue from 'vue'
import Router from 'vue-router'

Vue.use(Router)

export default new Router({
  routes: [
    {
      path: '/',
      component: () => import('../Pages/Home.vue'),
    },
    {
      path: '/dashboard',
      component: () => import('../Pages/Dashboard.vue'),
    },
  ],
})